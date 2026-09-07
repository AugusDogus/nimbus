import { TRPCError } from "@trpc/server";
import type { DriveStore, DriveUser, Grant, Permission } from "./drive-store";
import { isWithinPath } from "./safe-path";

const rank = { read: 1, write: 2, admin: 3 } as const;

export const canAccess = (
  grants: Grant[],
  requested: string,
  required: Permission,
) =>
  grants.some(
    (grant) =>
      isWithinPath(grant.path, requested) &&
      rank[grant.permission] >= rank[required],
  );

export async function getAccess(store: DriveStore, userId: string) {
  const user = await store.getUser(userId);
  if (!user || user.banned)
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Sign in to access your drive.",
    });
  const grants = await store.grantsForUser(userId);
  return accessFor(user, grants);
}

export function accessFor(user: DriveUser, grants: Grant[]) {
  const isAdmin = user.role.split(",").includes("admin");
  const can = (requested: string, permission: Permission) =>
    isAdmin || canAccess(grants, requested, permission);
  const canBrowse = (requested: string) =>
    requested === "" ||
    can(requested, "read") ||
    grants.some((grant) => isWithinPath(requested, grant.path));
  return {
    user,
    grants,
    isAdmin,
    can,
    canBrowse,
    require(requested: string, permission: Permission) {
      if (!can(requested, permission))
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `You need ${permission} permission for this item. Ask its owner for access.`,
        });
    },
    requireAdmin() {
      if (!isAdmin)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only server administrators can manage users and groups.",
        });
    },
  };
}

export type Access = ReturnType<typeof accessFor>;

export const permissionFor = (access: Access, path: string): Permission =>
  access.can(path, "admin")
    ? "admin"
    : access.can(path, "write")
      ? "write"
      : "read";
