import { TRPCError } from "@trpc/server";
import { rm } from "node:fs/promises";
import path from "node:path";
import { getAccess, type Access } from "./access";
import { getDataRoot } from "./data-root";
import type { DriveStore } from "./drive-store";
import { mutateFiles } from "./file-mutations";
import { FileVersions } from "./file-versions";

/**
 * Permanently delete every trash item the caller can manage: their own items, or all items for
 * server administrators. Runs in the mutation queue so a concurrent restore cannot race it.
 */
export async function emptyTrash(store: DriveStore, access: Access) {
  return mutateFiles([], { userId: access.user.id }, async () => {
    const current = await getAccess(store, access.user.id);
    const items = await store.listTrash(current.isAdmin ? null : current.user.id);
    const trashDirectory = path.join(getDataRoot(), ".nimbus", "trash");
    let deleted = 0;
    for (const item of items) {
      try {
        const trashed = path.join(trashDirectory, item.id);
        await FileVersions.discardTree(store.versions, getDataRoot(), trashed);
        await rm(trashed, { recursive: true, force: true });
        await store.removeTrash(item.id);
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Emptied ${deleted} of ${items.length} trash items, then could not delete "${item.path}". The remaining items are still in trash. Try again, and check the server log if it keeps failing.`,
          cause: error,
        });
      }
      deleted++;
    }
    return { deleted };
  });
}
