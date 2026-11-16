import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** Long enough to start a download, short enough that a leaked URL soon stops working. */
export const DOWNLOAD_LINK_TTL_MS = 5 * 60 * 1000;

const claimsSchema = z.object({
  v: z.literal(1),
  g: z.string().min(1),
  p: z.string(),
  e: z.number().int(),
});

const mac = (secret: string, payload: string) =>
  createHmac(
    "sha256",
    new Uint8Array(
      hkdfSync(
        "sha256",
        secret,
        new Uint8Array(0),
        "nimbus/mcp-download/v1",
        32,
      ),
    ),
  )
    .update(payload)
    .digest();

/**
 * A signed, expiring reference to one drive path for one MCP connection. It
 * carries no access by itself: the download route re-checks the connection,
 * the account, and the account's read permission on every request.
 */
export function signDownloadLink(
  secret: string,
  grantId: string,
  path: string,
  now: number,
) {
  const expiresAt = now + DOWNLOAD_LINK_TTL_MS;
  const payload = Buffer.from(
    JSON.stringify({ v: 1, g: grantId, p: path, e: expiresAt }),
  ).toString("base64url");
  return {
    token: `${payload}.${mac(secret, payload).toString("base64url")}`,
    expiresAt,
  };
}

export type DownloadLinkCheck =
  | { kind: "valid"; grantId: string; path: string }
  | { kind: "invalid" }
  | { kind: "expired" };

export function verifyDownloadLink(
  secret: string,
  token: string,
  now: number,
): DownloadLinkCheck {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return { kind: "invalid" };
  const presented = Buffer.from(signature, "base64url");
  const expected = mac(secret, payload);
  if (
    presented.length !== expected.length ||
    !timingSafeEqual(presented, expected)
  )
    return { kind: "invalid" };
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { kind: "invalid" };
  }
  const claims = claimsSchema.safeParse(json);
  if (!claims.success) return { kind: "invalid" };
  if (claims.data.e <= now) return { kind: "expired" };
  return { kind: "valid", grantId: claims.data.g, path: claims.data.p };
}
