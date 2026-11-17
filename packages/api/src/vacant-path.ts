import { lstat } from "node:fs/promises";
import type { DriveStore } from "./drive-store";
import { isFsError } from "./safe-path";

/**
 * Creating content at a drive path.
 *
 * Links, grants, file requests, stars, dead properties and version history belong to a path.
 * Nimbus's own moves and trash take them along, but content removed outside Nimbus (over SMB
 * or NFS, by a shell) leaves them behind at its path. Every way Nimbus creates an item there
 * (folders, copies, uploads and their folders, staged writes such as WebDAV PUT, the editor and
 * MCP, WebDAV MKCOL and LOCK, home folders) claims the path first, holding it in its mutation
 * scope, so new content never inherits what the removed content was shared with.
 */
export type VacantClaim =
  /** Nothing is at the path; records left there were deleted. Create the content now. */
  | { kind: "claimed" }
  /** Something exists at the path; its records were left alone. */
  | { kind: "occupied" };

/**
 * Claim `target` for new content if nothing exists there. Claim before creating, inside the
 * mutation scope that holds the path: a failed claim then creates nothing, and no reader can
 * see new content while old records still apply to it. An item another program creates at the
 * path between the claim and the creation is new content too, so the claim fits it as well.
 */
async function claim(
  drive: Pick<DriveStore, "claimVacant">,
  target: { absolute: string; relative: string },
): Promise<VacantClaim> {
  try {
    await lstat(target.absolute);
    return { kind: "occupied" };
  } catch (error) {
    // A missing parent, or a file where a parent folder should be, leaves the path vacant too.
    if (!isFsError(error, "ENOENT") && !isFsError(error, "ENOTDIR"))
      throw error;
  }
  await drive.claimVacant(target.relative);
  return { kind: "claimed" };
}

export const VacantPath = { claim } as const;
