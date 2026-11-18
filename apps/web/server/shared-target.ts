import { TRPCError } from "@trpc/server";
import type { Access } from "@nimbus/api/access";
import type { Share } from "@nimbus/api/drive-store";
import { safePath } from "@nimbus/api/file-operations";
import { isWithinPath } from "@nimbus/api/safe-path";

/**
 * The path a link names inside its shared folder, and an access that reads only there. Kept
 * apart from ./public-share, which imports the configured database, so it can be tested alone.
 */
export async function sharedTarget(
  share: Share,
  access: Access,
  child: string,
) {
  const target = await safePath([share.path, child].filter(Boolean).join("/"));
  if (!isWithinPath(share.path, target.relative))
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This path is outside the shared folder.",
    });
  // Built field by field: a link grants reading inside its path and nothing of its creator's
  // other rights, such as administration or grants elsewhere.
  const scoped: Access = {
    user: access.user,
    grants: [],
    isAdmin: false,
    requireAdmin() {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "A public link cannot manage users and groups.",
      });
    },
    can: (requested, permission) =>
      permission === "read" &&
      isWithinPath(share.path, requested) &&
      access.can(requested, "read"),
    canBrowse: (requested) =>
      isWithinPath(share.path, requested) && access.can(requested, "read"),
    require(requested, permission) {
      if (!this.can(requested, permission))
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "This link does not grant access to that item.",
        });
    },
  };
  return { target, access: scoped };
}
