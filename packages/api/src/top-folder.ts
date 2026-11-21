import type { Access } from "./access";
import { isWithinPath } from "./safe-path";

/**
 * The folder Files opens for an account, relative to the drive root: the root itself, unless
 * the account reaches nothing outside its own home folder, when the home is its top. Read from
 * the account's grants, its groups' included, so the first grant elsewhere moves it to the root.
 */
export const TopFolder = {
  of(access: Pick<Access, "isAdmin" | "grants">, home: string | null): string {
    if (access.isAdmin || home === null) return "";
    return access.grants.every((grant) => isWithinPath(home, grant.path))
      ? home
      : "";
  },
} as const;
