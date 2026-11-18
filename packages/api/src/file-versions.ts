import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { copyFile, link, lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { DriveStore } from "./drive-store";
import { isFsError } from "./safe-path";
import { DriveFile } from "./drive-file";
import { Staging } from "./staging";
import { VacantPath } from "./vacant-path";

/**
 * File versioning.
 *
 * When a file is replaced, its previous content is kept under
 * `<data root>/.nimbus/versions` on the same filesystem, by reflink where
 * possible and otherwise by hardlink when the file has not been written for a
 * minute, so preserving a version rarely copies the file's bytes (see `preserve`).
 *
 * History belongs to a file's path, like its links, grants and stars. Renames,
 * moves, trash and restore through Nimbus relocate it in the same transaction
 * that relocates those records (`DriveStore.movePath`, `addTrash`,
 * `restoreTrash`), so it follows the file, and a file replaced by another
 * program's save-by-rename keeps it. Paths, unlike inode numbers, are stable
 * on every supported filesystem, including Unraid user shares, whose inode
 * numbers change across reboots and when Mover relocates a file. Renames made
 * outside Nimbus leave history at the old path, as they leave links and grants.
 */
export type FileVersion = {
  id: string;
  /**
   * Where the file lives, relative to the data root: its drive path, or a
   * location under `trashLocation` while it is in trash.
   */
  path: string;
  /** File name when the version was archived, used for downloads. */
  name: string;
  size: number;
  /** Modification time of the archived content. */
  modifiedAt: number;
  archivedAt: number;
  archivedBy: string | null;
};

/**
 * Version records. Relocation under a path is not here: the drive store does
 * it inside the transactions that relocate sharing records.
 */
export type FileVersionStore = {
  add(version: FileVersion): Promise<void>;
  /** Newest first. */
  list(path: string): Promise<FileVersion[]>;
  get(id: string): Promise<FileVersion | null>;
  /** Remove records and return the ones that existed. */
  remove(ids: readonly string[]): Promise<FileVersion[]>;
  /** Remove and return the records at or under a path. */
  removeAt(path: string): Promise<FileVersion[]>;
  archivedBefore(cutoff: number): Promise<FileVersion[]>;
  /** Which of these ids still have records. */
  existing(ids: readonly string[]): Promise<Set<string>>;
};

export const versionRetention = {
  /** Versions kept per file; older ones are removed after each save. */
  maxCount: 25,
  /** Versions older than this are removed by hourly maintenance. */
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
} as const;

/**
 * Where the history of a trashed item's files lives until it is restored or
 * purged: the item's own location on disk. Drive paths can never start with
 * `.nimbus`, so trashed history never matches a live file.
 */
const trashLocation = (trashId: string) => `.nimbus/trash/${trashId}`;

const versionsDirectory = (dataRoot: string) =>
  path.join(dataRoot, ".nimbus", "versions");

function payloadPath(dataRoot: string, id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id))
    throw new Error(`Invalid file version id "${id}". Expected a UUID.`);
  return path.join(versionsDirectory(dataRoot), id.slice(0, 2), id);
}

async function fileStats(absolute: string) {
  try {
    const stats = await lstat(absolute, { bigint: true });
    return stats.isFile() ? stats : null;
  } catch (error) {
    if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR")) return null;
    throw error;
  }
}

/** Content written in place changes size or modification time. Inode numbers and ctime are not compared: neither is stable everywhere. */
const sameContent = (a: BigIntStats, b: BigIntStats | null) =>
  b !== null && a.size === b.size && a.mtimeNs === b.mtimeNs;

const unsupported = [
  "EXDEV",
  "EPERM",
  "EMLINK",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EINVAL",
  "ENOSYS",
];
const isUnsupported = (error: unknown) =>
  unsupported.some((code) => isFsError(error, code));

/**
 * A file not written for this long is taken to have no writer left, so its inode may become a
 * version by hardlink. A program that keeps a file open but idle for longer, then writes to it,
 * would still change that version; reflinks, preferred where the filesystem has them, never do.
 */
const quietBeforeLinkMs = 60 * 1000;

/**
 * Make `destination` hold `source`'s current content without copying bytes
 * where the filesystem allows. A reflink comes first: it shares extents but is
 * a separate inode, so a program still writing to the old file through an open
 * descriptor never changes the version. Without reflinks, a hardlink is used
 * when the inode has no other names (so no other path can edit it in place)
 * and has not been written recently (so no writer is likely to still hold it
 * open); otherwise the bytes are copied. The file is opened without following
 * symlinks first, and a hardlink, made by name, must name the opened inode.
 */
async function preserve(
  dataRoot: string,
  source: string,
  destination: string,
  now: number,
) {
  const opened = await DriveFile.openFile(source, dataRoot);
  try {
    try {
      await DriveFile.copyOpened(
        opened,
        destination,
        constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE,
      );
      return "reflink" as const;
    } catch (error) {
      if (!isUnsupported(error)) throw error;
    }
    if (
      opened.stats.nlink === 1 &&
      opened.stats.mtimeMs < now - quietBeforeLinkMs
    ) {
      try {
        await link(source, destination);
        const linked = await lstat(destination);
        if (linked.dev === opened.stats.dev && linked.ino === opened.stats.ino)
          return "link" as const;
        await rm(destination, { force: true });
        throw DriveFile.swapped();
      } catch (error) {
        if (!isUnsupported(error)) throw error;
      }
    }
    await DriveFile.copyOpened(opened, destination, constants.COPYFILE_EXCL);
    return "copy" as const;
  } finally {
    await opened.handle.close();
  }
}

/** Payloads removed at once: purging a large folder's history removes thousands. */
const removalBatch = 256;

async function removePayloads(
  dataRoot: string,
  versions: readonly FileVersion[],
) {
  for (let start = 0; start < versions.length; start += removalBatch)
    await Promise.all(
      versions
        .slice(start, start + removalBatch)
        .map((version) =>
          rm(payloadPath(dataRoot, version.id), { force: true }),
        ),
    );
}

/** Remove the history at or under `location`, records and payloads. */
async function discard(
  store: FileVersionStore,
  dataRoot: string,
  location: string,
) {
  await removePayloads(dataRoot, await store.removeAt(location));
}

/** What committing content needs from the drive store: version records, and claims of vacant paths. */
export type ContentDrive = Pick<
  DriveStore,
  "versions" | "claimVacant" | "caseVariants" | "hasRecordsNear"
>;

export type ReplacementResult =
  | { kind: "created" }
  /** `version` is null when the previous content was empty and not worth keeping. */
  | { kind: "replaced"; version: FileVersion | null };

/**
 * The single commit point for replacing a file's content. Moves `incoming`
 * over the file at `path` (relative to `dataRoot`) atomically, first
 * preserving the previous content as a version. Readers see either the old or
 * the new file, never neither. Call inside `mutateFiles` so the target cannot
 * change meanwhile.
 *
 * `incoming` is any complete regular file on the same filesystem as the
 * target: a staged upload, WebDAV PUT body, editor save or COPY, or a live
 * file moved over another one, whose own history the caller discards. If
 * preserving fails, nothing is replaced and `incoming` is left where it was.
 */
async function commitReplacement({
  drive,
  dataRoot,
  path: relative,
  incoming,
  archivedBy,
  now = Date.now(),
}: {
  /** Version records, and the claim of a vacant path when the file is new. */
  drive: ContentDrive;
  dataRoot: string;
  path: string;
  incoming: string;
  archivedBy: string | null;
  now?: number;
}): Promise<ReplacementResult> {
  const store = drive.versions;
  const target = path.join(dataRoot, relative);
  const previous = await fileStats(target);
  if (!previous) {
    // Records left by content removed outside Nimbus never attach to a new file.
    const claim = await VacantPath.claim(drive, {
      absolute: target,
      relative,
    });
    if (claim.kind === "occupied")
      throw new Error(
        `${target} is not a regular file, so Nimbus did not replace it. Callers refuse folders and special files before committing; nothing was changed and the new content is still staged.`,
      );
    await DriveFile.renameChecked(incoming, target, dataRoot);
    return { kind: "created" };
  }
  if (previous.size === BigInt(0)) {
    // An empty file, such as one created by a WebDAV LOCK before its PUT, has
    // nothing to keep; its earlier history stays with the path.
    await DriveFile.renameChecked(incoming, target, dataRoot);
    return { kind: "replaced", version: null };
  }
  const version: FileVersion = {
    id: randomUUID(),
    path: relative,
    name: path.basename(target),
    size: Number(previous.size),
    modifiedAt: Number(previous.mtimeMs),
    archivedAt: now,
    archivedBy,
  };
  const payload = payloadPath(dataRoot, version.id);
  await mkdir(path.dirname(payload), { recursive: true });
  await preserve(dataRoot, target, payload, Date.now());
  if (!sameContent(previous, await fileStats(target))) {
    // Another program changed the file while it was being preserved.
    await rm(payload, { force: true });
    throw new Error(
      `${target} changed while its previous version was being saved. Nothing was replaced and the new content is still staged; try saving again.`,
    );
  }
  // Recorded before the content is replaced, so a crash in between leaves at worst a version
  // identical to the current content, never replaced content without its version.
  await store.add(version);
  try {
    await DriveFile.renameChecked(incoming, target, dataRoot);
  } catch (error) {
    await store.remove([version.id]);
    await rm(payload, { force: true });
    throw error;
  }
  const excess = (await store.list(relative)).slice(versionRetention.maxCount);
  if (excess.length)
    await removePayloads(
      dataRoot,
      await store.remove(excess.map((entry) => entry.id)),
    );
  return { kind: "replaced", version };
}

/** History of the file at a drive path, newest first. */
function history(store: FileVersionStore, relative: string) {
  return store.list(relative);
}

/** A version of the file at a drive path, or null if it belongs to another file. */
async function find(store: FileVersionStore, relative: string, id: string) {
  const version = await store.get(id);
  return version?.path === relative
    ? { version, payload: (dataRoot: string) => payloadPath(dataRoot, id) }
    : null;
}

/**
 * Restore a version by replacing the live file with an independent copy of it
 * (a reflink where supported), which itself keeps the current content as a
 * version. The restored version stays in history.
 */
async function restore({
  drive,
  dataRoot,
  path: relative,
  id,
  archivedBy,
}: {
  drive: ContentDrive;
  dataRoot: string;
  path: string;
  id: string;
  archivedBy: string | null;
}) {
  const found = await find(drive.versions, relative, id);
  if (!found) return { kind: "not-found" } as const;
  // Staged where the file lives, which may be a folder mounted inside the drive.
  const staging = await Staging.directoryFor(
    dataRoot,
    path.join(dataRoot, relative),
  );
  const incoming = path.join(staging, `${randomUUID()}.restore`);
  try {
    // Never link: the live file must not share an inode with its own history.
    await copyFile(
      found.payload(dataRoot),
      incoming,
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
    );
    return await commitReplacement({
      drive,
      dataRoot,
      path: relative,
      incoming,
      archivedBy,
    });
  } finally {
    await rm(incoming, { force: true });
  }
}

/**
 * Remove versions past the age limit, and payloads left without a record by an
 * interrupted save or a discarded record once they are a day old.
 */
async function cleanup(
  store: FileVersionStore,
  dataRoot: string,
  now = Date.now(),
) {
  const expired = await store.archivedBefore(now - versionRetention.maxAgeMs);
  if (expired.length)
    await removePayloads(
      dataRoot,
      await store.remove(expired.map((version) => version.id)),
    );
  let shards;
  try {
    shards = await readdir(versionsDirectory(dataRoot));
  } catch (error) {
    if (isFsError(error, "ENOENT")) return;
    throw error;
  }
  for (const shard of shards) {
    const directory = path.join(versionsDirectory(dataRoot), shard);
    const ids = (await readdir(directory)).filter((id) =>
      /^[a-f0-9-]{36}$/.test(id),
    );
    const known = await store.existing(ids);
    for (const id of ids) {
      if (known.has(id)) continue;
      const file = path.join(directory, id);
      // ctime moves when the payload is linked or written, unlike mtime.
      if ((await lstat(file)).ctimeMs < now - 24 * 60 * 60 * 1000)
        await rm(file, { force: true });
    }
  }
}

export const FileVersions = {
  trashLocation,
  commitReplacement,
  history,
  find,
  restore,
  discard,
  cleanup,
} as const;
