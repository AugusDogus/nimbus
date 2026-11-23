import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { Staging } from "@nimbus/api/staging";
import type { DriveStore } from "@nimbus/api/drive-store";
import { recordAudit } from "@nimbus/api/audit";
import { reservationLifetimeMs } from "@nimbus/api/file-request";
import { FileVersions } from "@nimbus/api/file-versions";
import { mutateFiles } from "@nimbus/api/file-mutations";
import { PendingChanges } from "@nimbus/api/pending-changes";
import { isFsError } from "@nimbus/api/safe-path";
import { getConfigRoot } from "./storage-paths";
import { UploadLocks } from "./upload-locks";

const day = 24 * 60 * 60 * 1000;

async function cleanFiles(
  directory: string,
  cutoff: number,
  groupUploads: boolean,
) {
  const groups = new Map<string, string[]>();
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isFsError(error, "ENOENT")) return;
    throw error;
  }
  for (const entry of entries) {
    if (groupUploads && entry.isDirectory() && entry.name.endsWith(".copy")) {
      // A folder copy's staging tree, left behind if Nimbus stopped while copying.
      const folder = path.join(directory, entry.name);
      if (!Staging.isHeld(folder) && (await lstat(folder)).mtimeMs < cutoff)
        await rm(folder, { recursive: true, force: true });
      continue;
    }
    if (!entry.isFile()) continue;
    const key = groupUploads
      ? entry.name.replace(/\.(json|done(?:\.tmp)?)$/, "")
      : entry.name;
    const filenames = groups.get(key) ?? [];
    filenames.push(path.join(directory, entry.name));
    groups.set(key, filenames);
  }
  for (const [key, filenames] of groups) {
    if (!(await allExpired(filenames, cutoff))) continue;
    if (!groupUploads) {
      for (const filename of filenames) await rm(filename, { force: true });
      continue;
    }
    // A request may resume the upload between listing and deleting, here or on another server
    // during an update: decide again holding its lock, which every tus request writes under,
    // over every file the upload may have by now.
    const companions = ["", ".json", ".done", ".done.tmp"].map((suffix) =>
      path.join(directory, key + suffix),
    );
    await UploadLocks.hold(key, async () => {
      if (!(await allExpired(companions, cutoff))) return;
      for (const filename of companions) await rm(filename, { force: true });
    });
  }
}

/**
 * Whether every one of `filenames` that exists is a file untouched since `cutoff`. tus updates
 * the data file during PATCH, while its metadata can be much older, so an upload is retained
 * until every companion file has been inactive for a day.
 */
async function allExpired(filenames: string[], cutoff: number) {
  for (const filename of filenames) {
    try {
      const details = await lstat(filename);
      if (!details.isFile() || details.mtimeMs >= cutoff) return false;
    } catch (error) {
      if (!isFsError(error, "ENOENT")) throw error;
    }
  }
  return true;
}

export async function cleanExpiredData(
  store: Pick<
    DriveStore,
    | "listTrash"
    | "getTrash"
    | "removeTrash"
    | "removePendingChange"
    | "fileRequests"
    | "versions"
    | "pruneRevokedShares"
  >,
  dataRoot: string,
  now = Date.now(),
  configRoot = getConfigRoot(dataRoot),
) {
  const internal = path.join(dataRoot, ".nimbus");
  // Each item and step on its own: one that fails, such as a trashed folder holding another
  // user's files Nimbus may not delete, must not keep the rest from being cleaned every hour.
  const failures: string[] = [];
  const attempt = async (what: string, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      failures.push(
        `${what}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  for (const listed of await store.listTrash(null)) {
    if (listed.expiresAt > now) continue;
    // Each expired item is held and read again, so a restore cannot race its deletion.
    await attempt(
      `deleting expired trash item ${listed.id} (${listed.path})`,
      () =>
        mutateFiles(
          [],
          { userId: "maintenance" },
          async () => {
            const item = await store.getTrash(listed.id);
            if (!item || item.expiresAt > now) return;
            const trashed = path.join(internal, "trash", item.id);
            await FileVersions.discard(
              store.versions,
              dataRoot,
              FileVersions.trashLocation(item.id),
            );
            await rm(trashed, { recursive: true, force: true });
            await store.removeTrash(item.id);
            await PendingChanges.forgetTrashItem(store, item.id);
            recordAudit({
              action: "trash.expired",
              actor: { type: "system" },
              target: { type: "path", id: item.path },
              details: { trashId: item.id, deletedBy: item.deletedBy },
            });
          },
          { trash: [listed.id] },
        ),
    );
  }
  // Folders mounted inside the drive stage their own writes; see Staging.
  await attempt("listing staging folders", async () => {
    for (const staging of await Staging.directories(dataRoot))
      await attempt(`cleaning staging folder ${staging}`, () =>
        cleanFiles(staging, now - day, true),
      );
  });
  await attempt("releasing abandoned file request uploads", () =>
    store.fileRequests.releaseAbandoned(now - reservationLifetimeMs),
  );
  await attempt("removing expired revoked-link records", () =>
    store.pruneRevokedShares(now),
  );
  await attempt("removing expired versions", () =>
    FileVersions.cleanup(store.versions, dataRoot, now),
  );
  await attempt("removing old thumbnails", () =>
    cleanFiles(
      path.join(configRoot, "cache", "thumbnails"),
      now - 30 * day,
      false,
    ),
  );
  if (failures.length)
    throw new Error(
      `${failures.length} retention ${failures.length === 1 ? "step" : "steps"} failed, and the rest was cleaned: ${failures.join("; ")}`,
    );
}
