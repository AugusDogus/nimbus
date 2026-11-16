import type { Access } from "./access";
import type { Permission } from "./drive-store";
import { isWithinPath } from "./safe-path";

const rank = { read: 1, write: 2, admin: 3 } as const;
const byRank = [null, "read", "write", "admin"] as const;

/**
 * Resolves the permission of every direct child of one folder with a single pass over the
 * caller's grants. Equivalent to `canBrowse` plus `permissionFor` per child, which scan all
 * grants several times per entry and dominate large listings.
 */
export type FolderAccess = {
  /** The child's permission, or null when the caller cannot see it. */
  permissionOf(name: string): Permission | null;
};

function of(access: Access, folder: string): FolderAccess {
  if (access.isAdmin) return { permissionOf: () => "admin" };
  // Grants at or above the folder apply to every child.
  let inherited = 0;
  // Grants on a child or inside it, keyed by the child's name.
  const exact = new Map<string, number>();
  const nested = new Set<string>();
  const prefix = folder ? `${folder}/` : "";
  for (const grant of access.grants) {
    if (isWithinPath(grant.path, folder)) {
      inherited = Math.max(inherited, rank[grant.permission]);
      continue;
    }
    if (!grant.path.startsWith(prefix)) continue;
    const rest = grant.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    const name = slash < 0 ? rest : rest.slice(0, slash);
    // A grant on the child or below it makes the child browsable.
    nested.add(name);
    if (slash < 0)
      exact.set(name, Math.max(exact.get(name) ?? 0, rank[grant.permission]));
  }
  return {
    permissionOf(name) {
      const level = Math.max(inherited, exact.get(name) ?? 0);
      if (level > 0) return byRank[level];
      return nested.has(name) ? "read" : null;
    },
  };
}

export const FolderAccess = { of } as const;
