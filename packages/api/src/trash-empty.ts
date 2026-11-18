import { TRPCError } from "@trpc/server";
import { rm } from "node:fs/promises";
import path from "node:path";
import { getAccess, type Access } from "./access";
import { auditUser, recordAudit } from "./audit";
import { getDataRoot } from "./data-root";
import type { DriveStore } from "./drive-store";
import { mutateFiles } from "./file-mutations";
import { FileVersions } from "./file-versions";
import { PendingChanges } from "./pending-changes";

/**
 * Permanently delete every trash item the caller can manage: their own items, or all items for
 * server administrators. Holds the whole trash, so a concurrent trash, restore or purge cannot race it.
 */
export async function emptyTrash(store: DriveStore, access: Access) {
  return mutateFiles(
    [],
    { userId: access.user.id },
    async () => {
      const current = await getAccess(store, access.user.id);
      const items = await store.listTrash(
        current.isAdmin ? null : current.user.id,
      );
      const trashDirectory = path.join(getDataRoot(), ".nimbus", "trash");
      let deleted = 0;
      for (const item of items) {
        try {
          const trashed = path.join(trashDirectory, item.id);
          await FileVersions.discard(
            store.versions,
            getDataRoot(),
            FileVersions.trashLocation(item.id),
          );
          await rm(trashed, { recursive: true, force: true });
          await store.removeTrash(item.id);
          await PendingChanges.forgetTrashItem(store, item.id);
          recordAudit({
            action: "trash.purged",
            actor: auditUser(current.user),
            target: { type: "path", id: item.path },
            details: { trashId: item.id, emptied: true },
          });
        } catch (error) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Emptied ${deleted} of ${items.length} trash items, then could not delete "${item.path}". The remaining items are still in trash. Try again, and check the server log if it keeps failing.`,
            cause: error,
          });
        }
        deleted++;
      }
      recordAudit({
        action: "trash.emptied",
        actor: auditUser(current.user),
        details: { deleted, everyone: current.isAdmin },
      });
      return { deleted };
    },
    // The whole trash: nothing is trashed, restored or purged while it empties.
    { trash: "all" },
  );
}
