import {
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { hashToken } from "../mcp/oauth/secrets";
import type { LibraryApiError } from "./library-api-error";
import type { LibraryContext } from "./library-context";
import { PairedDevices, type PairedDevice } from "./paired-devices";

/**
 * Short-lived permission to fetch one file of a library without an Authorization header, for
 * media players that cannot attach one to their requests. Minting returns two separate secrets:
 *
 * - a ticket, carried in the URL's query string: claims (session, device, item, file version,
 *   expiry) sealed with an HMAC, so a forged or altered ticket is recognized without a lookup;
 * - a cookie, a random 256-bit value stored only as a hash in the ticket's session.
 *
 * A request needs both: a URL copied from a log is useless alone, and a cookie names one session
 * of one item. Sessions live in this process's memory: a restart ends every one, and their
 * tickets then answer `stream_expired`, so the client mints again. Each device keeps at most
 * `MAX_TICKETS_PER_DEVICE` sessions (minting replaces its oldest) and sends at most
 * `MAX_BODIES_PER_DEVICE` files at once.
 */

export const MAX_TICKETS_PER_DEVICE = 4;
export const MAX_BODIES_PER_DEVICE = 2;
/** How long a ticket lasts when the file's duration is unknown. */
export const DEFAULT_TICKET_MS = 4 * 60 * 60 * 1000;
/** The longest any ticket lasts. */
export const MAX_TICKET_MS = 8 * 60 * 60 * 1000;

type Session = {
  id: string;
  deviceId: string;
  itemId: string;
  version: string;
  expiresAt: number;
  cookieHash: string;
};

export type MediaGrant = {
  device: PairedDevice;
  session: Pick<Session, "id" | "itemId" | "version" | "expiresAt">;
};

export type MediaCheck =
  | { ok: true; grant: MediaGrant }
  | { ok: false; error: LibraryApiError };

const sessions = new Map<string, Session>();
/** Each device's sessions, oldest first. */
const byDevice = new Map<string, string[]>();
/** Bodies being sent, per device. */
const bodies = new Map<string, number>();

const claims = z.object({
  v: z.literal(1),
  sid: z.string().min(1).max(64),
  dev: z.string().min(1).max(200),
  itm: z.string().min(1).max(100),
  ver: z.string().min(1).max(128),
  exp: z.number().int(),
});

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

/** Forget sessions that expired, and devices without sessions. */
function prune(now: number) {
  for (const [id, session] of sessions)
    if (session.expiresAt <= now) sessions.delete(id);
  for (const [deviceId, ids] of byDevice) {
    const kept = ids.filter((id) => sessions.has(id));
    if (kept.length) byDevice.set(deviceId, kept);
    else byDevice.delete(deviceId);
  }
}

export const MediaTickets = {
  /**
   * A new ticket and cookie for `device` to fetch version `version` of item `itemId`. They last
   * `durationMs` plus an hour when the duration is known, otherwise four hours, at most eight
   * hours, and never past the device's idle deadline.
   */
  mint(
    ctx: Pick<LibraryContext, "now" | "secret" | "origin">,
    device: PairedDevice,
    itemId: string,
    version: string,
    durationMs: number | null,
  ) {
    const now = ctx.now();
    prune(now);
    const lifetime =
      durationMs === null
        ? DEFAULT_TICKET_MS
        : Math.min(Math.ceil(durationMs) + 60 * 60 * 1000, MAX_TICKET_MS);
    const expiresAt = Math.min(now + lifetime, device.idleDeadline);
    const id = randomBytes(16).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    sessions.set(id, {
      id,
      deviceId: device.id,
      itemId,
      version,
      expiresAt,
      cookieHash: hashToken(secret),
    });
    const ids = [...(byDevice.get(device.id) ?? []), id];
    while (ids.length > MAX_TICKETS_PER_DEVICE) {
      const oldest = ids.shift();
      if (oldest !== undefined) sessions.delete(oldest);
    }
    byDevice.set(device.id, ids);
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        sid: id,
        dev: device.id,
        itm: itemId,
        ver: version,
        exp: expiresAt,
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
   * it names (a revoked device answers 401 even when the ticket also expired), then expiry and
   * the session, then the cookie.
   */
  check(
    ctx: Pick<LibraryContext, "db" | "now" | "secret" | "origin">,
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
    const session = sessions.get(parsed.data.sid);
    // Gone when it expired, was replaced by newer ones, or the server restarted since.
    if (parsed.data.exp <= now || !session || session.expiresAt <= now)
      return expired();
    const secret = cookie(request, cookieName(isSecure(ctx), session.id));
    if (
      secret === null ||
      hashToken(secret) !== session.cookieHash ||
      session.deviceId !== device.device.id ||
      session.itemId !== itemId ||
      session.version !== parsed.data.ver
    )
      return invalid();
    return { ok: true, grant: { device: device.device, session } };
  },

  /**
   * Take one of `deviceId`'s body slots, or null when it already sends as many files as it may.
   * The returned function gives the slot back, once.
   */
  claimBody(deviceId: string) {
    const sending = bodies.get(deviceId) ?? 0;
    if (sending >= MAX_BODIES_PER_DEVICE) return null;
    bodies.set(deviceId, sending + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (bodies.get(deviceId) ?? 1) - 1;
      if (left > 0) bodies.set(deviceId, left);
      else bodies.delete(deviceId);
    };
  },

  /** Forget every session and body, as a restart would. */
  resetForTest() {
    sessions.clear();
    byDevice.clear();
    bodies.clear();
  },
} as const;
