import { createHash, randomBytes } from "node:crypto";

/**
 * Codes and tokens are 256-bit random secrets with a recognizable prefix (so
 * secret scanners can find leaked ones). Only their SHA-256 hash is stored.
 */
export const TokenPrefix = {
  authorizationCode: "nimbus_mcp_code_",
  refreshToken: "nimbus_mcp_refresh_",
  accessToken: "nimbus_mcp_access_",
} as const;

export const AUTHORIZATION_CODE_TTL_MS = 60 * 1000;
/**
 * A redeemed code replayed by its own client within this window revokes the
 * grant (RFC 6749 section 4.1.2). Later replays only fail, so an old code from
 * browser history cannot disconnect the user.
 */
export const AUTHORIZATION_CODE_REPLAY_WINDOW_MS = 10 * 60 * 1000;
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * A rotated refresh token presented again within this window may be a client retrying an
 * answer it lost: it gets a new pair if nothing used the tokens from the first answer.
 * If something did, or the window has passed, two parties hold it and the connection is revoked.
 */
export const REFRESH_REUSE_GRACE_MS = 30 * 1000;

export const hashToken = (secret: string) =>
  createHash("sha256").update(secret, "utf8").digest("base64url");

export function mintSecret(prefix: string) {
  const secret = `${prefix}${randomBytes(32).toString("base64url")}`;
  return { secret, hash: hashToken(secret) };
}
