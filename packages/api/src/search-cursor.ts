/**
 * Page cursors as callers see them. The index's own cursor holds positions in
 * the whole drive's layout, which would tell a caller how many names it may
 * not read lie between the ones it can. Callers get it sealed instead:
 * encrypted and authenticated with a key that lives only in this process,
 * and padded to one length, so it reveals nothing. A cursor that was changed,
 * made before a restart (when the index is rebuilt anyway), or sealed for
 * another caller cannot be opened, and restarts the search.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const key = randomBytes(32);
const IV_BYTES = 12;
const TAG_BYTES = 16;
/**
 * Every index cursor is padded to this many bytes before sealing, so a
 * cursor's length cannot tell how far its numbers have grown. Index cursors
 * are digits and dashes, at most 94 characters (search-query.ts).
 */
const PLAIN_BYTES = 96;

/** An index cursor sealed for the caller `owner` (a user id), as URL-safe base64. */
function seal(cursor: string, owner: string) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(owner));
  if (Buffer.byteLength(cursor) > PLAIN_BYTES)
    throw new Error(
      `Search cursor "${cursor}" is longer than the ${PLAIN_BYTES} bytes every sealed cursor is padded to. Raise PLAIN_BYTES in search-cursor.ts together with the cursor format in search-query.ts.`,
    );
  const body = Buffer.concat([
    cipher.update(cursor.padEnd(PLAIN_BYTES), "utf8"),
    cipher.final(),
  ]);
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
    ])
      .toString("utf8")
      .trimEnd();
  } catch {
    // Altered, sealed by an earlier run of the server, or for someone else.
    return null;
  }
}

/** Longest sealed cursor accepted; every one sealed here is 166 characters. */
export const MAX_SEALED_CURSOR = 200;

export const SearchCursor = { seal, open } as const;
