import { z } from "zod";
import { LinkSeal } from "./link-seal";

/** Long enough to start a download, short enough that a leaked URL soon stops working. */
export const DOWNLOAD_LINK_TTL_MS = 5 * 60 * 1000;

const claimsSchema = z.object({
  v: z.literal(2),
  u: z.string().min(1),
  g: z.string().min(1),
  p: z.string(),
  e: z.number().int(),
});

/**
 * A sealed, expiring reference to one drive path for one account's MCP connection. It
 * carries no access by itself: the download route re-checks the connection, the account,
 * and the account's read permission on every request.
 */
export function signDownloadLink(
  secret: string,
  link: { userId: string; grantId: string; path: string },
  now: number,
) {
  const expiresAt = now + DOWNLOAD_LINK_TTL_MS;
  return {
    token: LinkSeal.seal(secret, "download", {
      v: 2,
      u: link.userId,
      g: link.grantId,
      p: link.path,
      e: expiresAt,
    }),
    expiresAt,
  };
}

export type DownloadLinkCheck =
  | { kind: "valid"; userId: string; grantId: string; path: string }
  | { kind: "invalid" }
  | { kind: "expired" };

export function verifyDownloadLink(
  secret: string,
  token: string,
  now: number,
): DownloadLinkCheck {
  const claims = claimsSchema.safeParse(
    LinkSeal.open(secret, "download", token),
  );
  if (!claims.success) return { kind: "invalid" };
  if (claims.data.e <= now) return { kind: "expired" };
  return {
    kind: "valid",
    userId: claims.data.u,
    grantId: claims.data.g,
    path: claims.data.p,
  };
}
