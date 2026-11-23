import {
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { pairedDevices } from "../db/schema";
import { hashToken } from "../mcp/oauth/secrets";
import type { LibraryApiError } from "./library-api-error";
import type { LibraryContext } from "./library-context";
import { PairedDevices, type PairedDevice } from "./paired-devices";

/**
 * Short-lived permission to fetch one file of a library without an Authorization header, for
 * media players that cannot attach one to their requests. Minting returns two separate secrets:
 *
 * - a ticket, carried in the URL's query string: claims (session, device, item, file version,
 *   expiry, server run, the device's mint number and the cookie's hash) sealed with an HMAC, so
 *   a forged or altered ticket is recognized without a lookup;
 * - a cookie, a random 256-bit value that exists in plain text only on the client; the ticket
 *   holds its hash.
 *
 * A request needs both: a URL copied from a log is useless alone, and a cookie belongs to one
 * ticket of one item. Nothing about a ticket is kept in memory, so every server process accepts
 * it, also the next one during an update. A ticket ends with the run of the server that minted
 * it (see ServerRun): after a restart it answers `stream_expired`, and the client mints again.
 * Each device's mints are numbered in the database, and only its newest
 * `MAX_TICKETS_PER_DEVICE` are accepted (minting replaces its oldest). There is no limit on
 * answers sent at once: a media player holds several ranges open while it buffers.
 */

export const MAX_TICKETS_PER_DEVICE = 4;
/** How long a ticket lasts when the file's duration is unknown. */
export const DEFAULT_TICKET_MS = 4 * 60 * 60 * 1000;
/** The longest any ticket lasts. */
export const MAX_TICKET_MS = 8 * 60 * 60 * 1000;

export type MediaGrant = {
  device: PairedDevice;
  session: { id: string; itemId: string; version: string; expiresAt: number };
};

export type MediaCheck =
  | { ok: true; grant: MediaGrant }
  | { ok: false; error: LibraryApiError };

const claims = z.object({
  v: z.literal(2),
  sid: z.string().min(1).max(64),
  dev: z.string().min(1).max(200),
  itm: z.string().min(1).max(100),
  ver: z.string().min(1).max(128),
  exp: z.number().int(),
  /** The run of the server that minted it. */
  run: z.string().min(1).max(64),
  /** The device's mint number for this ticket. */
  seq: z.number().int().positive(),
  /** The cookie's hash: only that cookie opens it. */
  ckh: z.string().min(1).max(128),
});

/** How many media addresses the device has minted; 0 for one that never minted any. */
const minted = (ctx: Pick<LibraryContext, "db">, deviceId: string) =>
  ctx.db
    .select({ minted: pairedDevices.mediaTicketsMinted })
    .from(pairedDevices)
    .where(eq(pairedDevices.grantId, deviceId))
    .get()?.minted ?? 0;

const mac = (secret: string, payload: string) =>
  createHmac(
    "sha256",
    new Uint8Array(
      hkdfSync(
        "sha256",
        secret,
        new Uint8Array(0),
        "nimbus/library-media/v1",
        32,
      ),
    ),
  )
    .update(payload)
    .digest();

const invalid = (): MediaCheck => ({
  ok: false,
  error: {
    code: "stream_invalid",
    message:
      "This media address or its cookie is not valid for this file. Ask for a new one.",
  },
});
const expired = (): MediaCheck => ({
  ok: false,
  error: {
    code: "stream_expired",
    message: "This media address has expired. Ask for a new one.",
  },
});

/** The cookie a session's secret travels in. `__Secure-` needs HTTPS; plain HTTP is local only. */
const cookieName = (secure: boolean, sessionId: string) =>
  `${secure ? "__Secure-" : ""}nimbus-media-${sessionId}`;

const isSecure = (ctx: Pick<LibraryContext, "origin">) =>
  ctx.origin.kind === "configured" && ctx.origin.origin.startsWith("https:");

/** The value of cookie `name` in `request`, or null. */
function cookie(request: Request, name: string) {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name)
      return part.slice(separator + 1).trim();
  }
  return null;
}

export const MediaTickets = {
  /**
   * A new ticket and cookie for `device` to fetch version `version` of item `itemId`. They last
   * `durationMs` plus an hour when the duration is known, otherwise four hours, at most eight
   * hours, and never past the device's idle deadline.
   */
  mint(
    ctx: Pick<LibraryContext, "db" | "now" | "secret" | "origin" | "run">,
    device: PairedDevice,
    itemId: string,
    version: string,
    durationMs: number | null,
  ) {
    const now = ctx.now();
    const lifetime =
      durationMs === null
        ? DEFAULT_TICKET_MS
        : Math.min(Math.ceil(durationMs) + 60 * 60 * 1000, MAX_TICKET_MS);
    const expiresAt = Math.min(now + lifetime, device.idleDeadline);
    const id = randomBytes(16).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    // Numbered in the database, so every server process counts the same mints.
    const seq =
      ctx.db
        .update(pairedDevices)
        .set({
          mediaTicketsMinted: sql`${pairedDevices.mediaTicketsMinted} + 1`,
        })
        .where(eq(pairedDevices.grantId, device.id))
        .returning({ minted: pairedDevices.mediaTicketsMinted })
        .get()?.minted ?? null;
    if (seq === null)
      throw new Error(
        `Paired device ${device.id} has no device record, so no media address was made for it. Pair the device again.`,
      );
    const payload = Buffer.from(
      JSON.stringify({
        v: 2,
        sid: id,
        dev: device.id,
        itm: itemId,
        ver: version,
        exp: expiresAt,
        run: ctx.run(),
        seq,
        ckh: hashToken(secret),
      } satisfies z.infer<typeof claims>),
    ).toString("base64url");
    const secure = isSecure(ctx);
    const maxAge = Math.max(0, Math.floor((expiresAt - now) / 1000));
    return {
      ticket: `${payload}.${mac(ctx.secret, payload).toString("base64url")}`,
      expiresAt,
      setCookie: [
        `${cookieName(secure, id)}=${secret}`,
        "Path=/api/library/v1/media",
        `Max-Age=${maxAge}`,
        "HttpOnly",
        "SameSite=Strict",
        ...(secure ? ["Secure"] : []),
      ].join("; "),
    };
  },

  /**
   * Whether `request`, for item `itemId`, carries a valid ticket and its cookie. Checked in this
   * order, so nothing is trusted before it is authenticated: the ticket's seal, then the device
   * it names (a revoked device answers 401 even when the ticket also expired), then expiry, the
   * server run and whether a newer mint replaced it, then the cookie.
   */
  check(
    ctx: Pick<LibraryContext, "db" | "now" | "secret" | "origin" | "run">,
    request: Request,
    itemId: string,
  ): MediaCheck {
    const ticket = new URL(request.url).searchParams.get("ticket") ?? "";
    const [payload, signature, extra] = ticket.split(".");
    if (!payload || !signature || extra !== undefined) return invalid();
    const presented = Buffer.from(signature, "base64url");
    const expected = mac(ctx.secret, payload);
    if (
      presented.length !== expected.length ||
      !timingSafeEqual(presented, expected)
    )
      return invalid();
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return invalid();
    }
    const parsed = claims.safeParse(json);
    if (!parsed.success || parsed.data.itm !== itemId) return invalid();
    const device = PairedDevices.byGrant(ctx, parsed.data.dev);
    if (!device.ok) return device;
    const now = ctx.now();
    const { sid, exp, run, seq, ckh, ver } = parsed.data;
    // Gone when it expired, the server restarted since, or newer ones replaced it.
    if (
      exp <= now ||
      run !== ctx.run() ||
      seq <= minted(ctx, device.device.id) - MAX_TICKETS_PER_DEVICE
    )
      return expired();
    const secret = cookie(request, cookieName(isSecure(ctx), sid));
    const presentedHash =
      secret === null ? null : Buffer.from(hashToken(secret));
    const sealedHash = Buffer.from(ckh);
    if (
      presentedHash === null ||
      presentedHash.length !== sealedHash.length ||
      !timingSafeEqual(presentedHash, sealedHash)
    )
      return invalid();
    return {
      ok: true,
      grant: {
        device: device.device,
        session: { id: sid, itemId, version: ver, expiresAt: exp },
      },
    };
  },
} as const;
