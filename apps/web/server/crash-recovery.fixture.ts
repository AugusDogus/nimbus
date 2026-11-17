/**
 * Child process for crash-recovery.test.ts: runs one file operation against the database and
 * data root the test prepared, and kills itself with SIGKILL between the operation's
 * filesystem and database steps, as a power cut or OOM kill would.
 *
 *   CRASH_DATABASE=… NIMBUS_DATA_ROOT=… CRASH_AT=trash|restore|move|version bun crash-recovery.fixture.ts
 */
import { getAccess } from "@nimbus/api/access";
import type { DriveStore } from "@nimbus/api/drive-store";
import { commitStagedFile, stageFile } from "@nimbus/api/file-content";
import { moveItem, restoreItem, trashItem } from "@nimbus/api/file-operations";
import path from "node:path";
import { openDatabase } from "./db/connection";
import { createDriveStore } from "./drive-store";

const database = process.env.CRASH_DATABASE;
const root = process.env.NIMBUS_DATA_ROOT;
const at = process.env.CRASH_AT;
if (!database || !root || !at)
  throw new Error("Set CRASH_DATABASE, NIMBUS_DATA_ROOT and CRASH_AT.");

const real = createDriveStore(openDatabase(database).db);
const crash = (): never => {
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL did not stop the process.");
};
const store: DriveStore = {
  ...real,
  // After the trash record, before the rename into trash.
  async addTrash(item) {
    await real.addTrash(item);
    return at === "trash" ? crash() : undefined;
  },
  // After the rename out of trash, before sharing is reattached.
  async restoreTrash(id) {
    return at === "restore" ? crash() : real.restoreTrash(id);
  },
  // After the rename, before sharing and history are relocated.
  async movePath(from, to, settles) {
    return at === "move" ? crash() : real.movePath(from, to, settles);
  },
  versions: {
    ...real.versions,
    // Before the version record is written.
    async add(version) {
      return at === "version" ? crash() : real.versions.add(version);
    },
  },
};
const access = await getAccess(store, "owner");
if (at === "trash") await trashItem(store, access, "doc.txt");
if (at === "restore") {
  const [item] = await store.listTrash(null);
  if (!item) throw new Error("The test did not put doc.txt in trash.");
  await restoreItem(store, access, item.id);
}
if (at === "move") await moveItem(store, access, "doc.txt", "moved.txt");
if (at === "version") {
  const staged = await stageFile("new", path.join(root, "doc.txt"));
  await commitStagedFile(
    { userId: "owner", drive: store, authorize: async () => access },
    "doc.txt",
    staged,
    () => true,
  );
}
throw new Error(
  `The ${at} operation finished without reaching its crash point.`,
);
