import { TRPCError } from "@trpc/server";
import type { DriveStore, DriveUser, Grant, Permission } from "./drive-store";

const rank = { read: 1, write: 2, admin: 3 } as const;

const parentOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

/**
 * A user's grants arranged for path questions: the strongest permission granted
 * at each path, and every path at or above a grant. Checking a path walks its
 * ancestors, so a check costs its depth, not the number of grants.
 */
type GrantIndex = { ranks: Map<string, number>; browsable: Set<string> };

function indexGrants(grants: readonly Grant[]): GrantIndex {
  const ranks = new Map<string, number>();
  const browsable = new Set<string>();
  for (const grant of grants) {
    ranks.set(
      grant.path,
      Math.max(ranks.get(grant.path) ?? 0, rank[grant.permission]),
    );
    for (let path = grant.path; !browsable.has(path); path = parentOf(path)) {
      browsable.add(path);
      if (path === "") break;
    }
  }
  return { ranks, browsable };
}

/** The strongest permission that applies at `requested`, from grants on it or its ancestors. */
function rankAt(index: GrantIndex, requested: string) {
  let best = 0;
  for (let path = requested; ; path = parentOf(path)) {
    best = Math.max(best, index.ranks.get(path) ?? 0);
    if (path === "") return best;
  }
}

export const canAccess = (
  grants: readonly Grant[],
  requested: string,
  required: Permission,
) => rankAt(indexGrants(grants), requested) >= rank[required];

type CachedAccess = { epoch: number; access: Access };
/** Recently used access per store and user, valid while the store's access epoch is unchanged. */
const cache = new WeakMap<DriveStore, Map<string, CachedAccess>>();
const maxCachedUsers = 10_000;
/**
 * The caller's account and grants. Reloaded whenever any grant, group,
 * membership or account changes, so revoked grants and disabled accounts take
 * effect on the next request; otherwise served from memory.
 */
export async function getAccess(
  store: DriveStore,
  userId: string,
  /** An epoch read after the change being handled, shared by callers handling the same change. */
  epochRead: Promise<number> = store.accessEpoch(),
) {
  const epoch = await epochRead;
  let users = cache.get(store);
  const cached = users?.get(userId);
  if (cached?.epoch === epoch) return cached.access;
  const user = await store.getUser(userId);
  if (!user || user.banned)
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Sign in to access your drive.",
    });
  const access = accessFor(user, await store.grantsForUser(userId));
  if (!users) {
    users = new Map();
    cache.set(store, users);
  }
  if (users.size >= maxCachedUsers) users.clear();
  users.set(userId, { epoch, access });
  return access;
}

export function accessFor(user: DriveUser, grants: Grant[]) {
  const isAdmin = user.role.split(",").includes("admin");
  const index = indexGrants(grants);
  const can = (requested: string, permission: Permission) =>
    isAdmin || rankAt(index, requested) >= rank[permission];
  const canBrowse = (requested: string) =>
    requested === "" ||
    index.browsable.has(requested) ||
    can(requested, "read");
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
