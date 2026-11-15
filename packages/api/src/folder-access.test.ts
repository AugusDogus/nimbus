import { describe, expect, it } from "bun:test";
import { accessFor, permissionFor } from "./access";
import type { Grant, Permission } from "./drive-store";
import { FolderAccess } from "./folder-access";

const user = (role: string) => ({ id: "u", name: "U", email: "u@example.test", role, banned: false });
const grant = (path: string, permission: Permission, index: number): Grant => ({ id: `g${index}`, subject: { type: "user", id: "u" }, path, permission });

describe("folder access for listings", () => {
  it("matches per-entry permission checks for every child of every folder", () => {
    const paths = ["", "a", "a/b", "a/b/c", "a/bc", "ab", "a/b/c/d", "x", "x/y"];
    const permissions: Permission[] = ["read", "write", "admin"];
    // Deterministic pseudo-random grant sets covering ancestors, exact matches, and descendants.
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let round = 0; round < 300; round++) {
      const grants = Array.from({ length: Math.floor(next() * 5) }, (_, index) =>
        grant(paths[Math.floor(next() * paths.length)] ?? "", permissions[Math.floor(next() * 3)] ?? "read", index));
      const access = accessFor(user(round % 10 === 0 ? "admin" : "user"), grants);
      for (const folder of paths) {
        const listing = FolderAccess.of(access, folder);
        for (const name of ["a", "b", "bc", "c", "d", "y", "z"]) {
          const child = folder ? `${folder}/${name}` : name;
          const expected = access.canBrowse(child) ? permissionFor(access, child) : null;
          expect({ round, child, permission: listing.permissionOf(name) }).toEqual({ round, child, permission: expected });
        }
      }
    }
  });
});
