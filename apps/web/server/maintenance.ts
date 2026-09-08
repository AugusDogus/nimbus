import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { DriveStore } from "@nimbus/api/drive-store";
import { mutateFiles } from "@nimbus/api/file-mutations";
import { isFsError } from "@nimbus/api/safe-path";
import { getConfigRoot } from "./storage-paths";

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
    if (!entry.isFile()) continue;
    const key = groupUploads
      ? entry.name.replace(/\.(json|done)$/, "")
      : entry.name;
    const filenames = groups.get(key) ?? [];
    filenames.push(path.join(directory, entry.name));
    groups.set(key, filenames);
  }
  for (const filenames of groups.values()) {
    let expired = true;
    for (const filename of filenames) {
      try {
        const details = await lstat(filename);
        if (!details.isFile() || details.mtimeMs >= cutoff) expired = false;
      } catch (error) {
        if (!isFsError(error, "ENOENT")) throw error;
      }
    }
    // tus updates the data file during PATCH, while its metadata can be much older.
    // Retain the entire upload until every companion file has been inactive for a day.
    if (expired)
      for (const filename of filenames) await rm(filename, { force: true });
  }
}

export async function cleanExpiredData(
  store: Pick<DriveStore, "listTrash" | "removeTrash">,
  dataRoot: string,
  now = Date.now(),
  configRoot = getConfigRoot(dataRoot),
) {
  const internal = path.join(dataRoot, ".nimbus");
  await mutateFiles([], { userId: "maintenance" }, async () => {
    // Read inside the mutation queue so restoration cannot race permanent deletion.
    for (const item of await store.listTrash(null)) {
      if (item.expiresAt > now) continue;
      await rm(path.join(internal, "trash", item.id), {
        recursive: true,
        force: true,
      });
      await store.removeTrash(item.id);
    }
  });
  await cleanFiles(path.join(internal, "uploads"), now - day, true);
  await cleanFiles(
    path.join(configRoot, "cache", "thumbnails"),
    now - 30 * day,
    false,
  );
}
