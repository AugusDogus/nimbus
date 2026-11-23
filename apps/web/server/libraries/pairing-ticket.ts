import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { BrowserSession, LibraryContext } from "./library-context";

/**
 * Proof that an Allow or Deny comes from the pairing page this session was shown for one
 * pairing request: CSRF protection on top of the origin check. Signed with a key derived from
 * BETTER_AUTH_SECRET. Format: base64url(JSON) "." base64url(HMAC-SHA256).
 */
export type PairingTicket = string;

export const PAIRING_TICKET_TTL_MS = 10 * 60 * 1000;

const claims = z.object({
  v: z.literal(1),
  sid: z.string().min(1),
  uid: z.string().min(1),
  pid: z.string().min(1),
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
        "nimbus/device-pairing/v1",
        32,
      ),
    ),
  )
    .update(payload)
    .digest();

export const PairingTicket = {
  issue(
    ctx: Pick<LibraryContext, "secret" | "now">,
    session: BrowserSession,
    pairingId: string,
  ): PairingTicket {
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        sid: session.sessionId,
        uid: session.userId,
        pid: pairingId,
        exp: ctx.now() + PAIRING_TICKET_TTL_MS,
      } satisfies z.infer<typeof claims>),
    ).toString("base64url");
    return `${payload}.${mac(ctx.secret, payload).toString("base64url")}`;
  },
  /** Whether `ticket` was issued to `session` for `pairingId` and has not expired. */
  verify(
    ctx: Pick<LibraryContext, "secret" | "now">,
    ticket: string,
    session: BrowserSession,
    pairingId: string,
  ) {
    const [payload, signature, extra] = ticket.split(".");
    if (!payload || !signature || extra !== undefined) return false;
    const presented = Buffer.from(signature, "base64url");
    const expected = mac(ctx.secret, payload);
    if (
      presented.length !== expected.length ||
      !timingSafeEqual(presented, expected)
    )
      return false;
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return false;
    }
    const parsed = claims.safeParse(json);
    return (
      parsed.success &&
      parsed.data.exp > ctx.now() &&
      parsed.data.sid === session.sessionId &&
      parsed.data.uid === session.userId &&
      parsed.data.pid === pairingId
    );
  },
} as const;
