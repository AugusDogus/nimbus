/**
 * Page cursors as callers see them. The index's own cursor holds positions in
 * the whole drive's layout, which would tell a caller how many names it may
 * not read lie between the ones it can. Callers get it sealed instead:
 * encrypted and authenticated with a key that lives only in this process, so
 * it reveals nothing but its length, and a cursor that was changed, made
 * before a restart (when the index is rebuilt anyway), or sealed for another
 * caller, cannot be opened and restarts the search.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const key = randomBytes(32);
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** An index cursor sealed for the caller `owner` (a user id), as URL-safe base64. */
function seal(cursor: string, owner: string) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(owner));
  const body = Buffer.concat([cipher.update(cursor, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

/** The index cursor inside a sealed one, or null unless it was sealed here, for `owner`, intact. */
function open(sealed: string, owner: string): string | null {
  const bytes = Buffer.from(sealed, "base64url");
  if (bytes.length <= IV_BYTES + TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      bytes.subarray(0, IV_BYTES),
    );
    decipher.setAAD(Buffer.from(owner));
    decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Altered, sealed by an earlier run of the server, or for someone else.
    return null;
  }
}

/** Longest sealed cursor: the index cursor is under 80 characters. */
export const MAX_SEALED_CURSOR = 200;

export const SearchCursor = { seal, open } as const;
