import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { isFsError } from "./safe-path";

/**
 * File versioning.
 *
 * When a file is replaced, its previous content is kept under
 * `<data root>/.nimbus/versions` on the same filesystem, by hardlink where
 * possible and by reflink otherwise, so preserving a version never copies the
 * file's bytes on filesystems that support either.
 *
 * History belongs to a file's identity (inode and birth time), not its path.
 * Renames, moves, trash and restore keep the inode, so history follows them,
 * including renames made by other programs, without any hook in those paths.
 * A replacement gives the file a new inode; `commitReplacement` carries the
 * history over to it. Permanent deletion discards history with `discardTree`.
 */
export type FileVersion = {
  id: string;
  /** Identity of the live file this version belongs to. */
  fileKey: string;
  /** File name when the version was archived, used for downloads. */
  name: string;
  size: number;
  /** Modification time of the archived content. */
  modifiedAt: number;
  archivedAt: number;
  archivedBy: string | null;
};

export type FileVersionStore = {
  add(version: FileVersion): Promise<void>;
  /** Carry history from a replaced inode to its successor. */
  rekey(from: string, to: string): Promise<void>;
  /** Newest first. */
  list(fileKey: string): Promise<FileVersion[]>;
  get(id: string): Promise<FileVersion | null>;
  /** Remove records and return the ones that existed. */
  remove(ids: readonly string[]): Promise<FileVersion[]>;
  removeFileKeys(keys: readonly string[]): Promise<FileVersion[]>;
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

const versionsDirectory = (dataRoot: string) =>
  path.join(dataRoot, ".nimbus", "versions");

function payloadPath(dataRoot: string, id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id))
    throw new Error(`Invalid file version id "${id}". Expected a UUID.`);
  return path.join(versionsDirectory(dataRoot), id.slice(0, 2), id);
}

function fileKey(stats: BigIntStats) {
  // Birth time distinguishes a reused inode number. Filesystems without it report 0.
  return `${stats.ino}:${stats.birthtimeNs}`;
}

async function identity(absolute: string) {
  try {
    const stats = await lstat(absolute, { bigint: true });
    return stats.isFile() ? { stats, key: fileKey(stats) } : null;
  } catch (error) {
    if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR")) return null;
    throw error;
  }
}

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
 * Make `destination` hold `source`'s current content without copying bytes
 * where the filesystem allows: a hardlink when the inode has no other names
 * (so no other path can edit it in place), else a reflink, else a full copy.
 */
async function preserve(source: string, destination: string, nlink: bigint) {
  if (nlink === BigInt(1)) {
    try {
      await link(source, destination);
      return "link" as const;
    } catch (error) {
      if (!isUnsupported(error)) throw error;
    }
  }
  try {
    await copyFile(
      source,
      destination,
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE,
    );
    return "reflink" as const;
  } catch (error) {
    if (!isUnsupported(error)) throw error;
  }
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  return "copy" as const;
}

async function removePayloads(
  dataRoot: string,
  versions: readonly FileVersion[],
) {
  for (const version of versions)
    await rm(payloadPath(dataRoot, version.id), { force: true });
}

export type ReplacementResult =
  | { kind: "created" }
  /** `version` is null when the previous content was empty and not worth keeping. */
  | { kind: "replaced"; version: FileVersion | null };

/**
 * The replaced file keeps its history under its new identity. Like links and
 * grants when content merges into another item, the incoming file's own
 * earlier history is discarded: the result is a new version of `target`.
 */
async function adoptHistory(
  store: FileVersionStore,
  dataRoot: string,
  previousKey: string,
  currentKey: string,
) {
  await removePayloads(dataRoot, await store.removeFileKeys([currentKey]));
  await store.rekey(previousKey, currentKey);
}

/**
 * The single commit point for replacing a file's content. Moves `incoming`
 * over `target` atomically, first preserving the previous content as a
 * version. Readers see either the old or the new file, never neither. Call
 * inside `mutateFiles` so the target cannot change meanwhile.
 *
 * `incoming` is any complete regular file on the same filesystem as `target`:
 * a staged upload, WebDAV PUT body, editor save or COPY, or a live file moved
 * over another one. If preserving fails, nothing is replaced and `incoming`
 * is left where it was.
 */
async function commitReplacement({
  store,
  dataRoot,
  target,
  incoming,
  archivedBy,
  now = Date.now(),
}: {
  store: FileVersionStore;
  dataRoot: string;
  target: string;
  incoming: string;
  archivedBy: string | null;
  now?: number;
}): Promise<ReplacementResult> {
  const previous = await identity(target);
  if (!previous) {
    await rename(incoming, target);
    return { kind: "created" };
  }
  if (previous.stats.size === BigInt(0)) {
    // An empty file, such as one created by a WebDAV LOCK before its PUT, has
    // nothing to keep; its earlier history still moves to the new content.
    await rename(incoming, target);
    const current = await identity(target);
    if (current) await adoptHistory(store, dataRoot, previous.key, current.key);
    return { kind: "replaced", version: null };
  }
  const version: FileVersion = {
    id: randomUUID(),
    fileKey: "",
    name: path.basename(target),
    size: Number(previous.stats.size),
    modifiedAt: Number(previous.stats.mtimeMs),
    archivedAt: now,
    archivedBy,
  };
  const payload = payloadPath(dataRoot, version.id);
  await mkdir(path.dirname(payload), { recursive: true });
  await preserve(target, payload, previous.stats.nlink);
  const preserved = await identity(target);
  if (preserved?.key !== previous.key) {
    // Another program replaced the file while it was being preserved.
    await rm(payload, { force: true });
    throw new Error(
      `${target} changed while its previous version was being saved. Nothing was replaced and the new content is still staged; try saving again.`,
    );
  }
  await rename(incoming, target);
  const current = await identity(target);
  if (!current)
    throw new Error(
      `${target} disappeared immediately after it was replaced. Its previous version is kept at ${payload}.`,
    );
  version.fileKey = current.key;
  await adoptHistory(store, dataRoot, previous.key, current.key);
  await store.add(version);
  const excess = (await store.list(current.key)).slice(
    versionRetention.maxCount,
  );
  if (excess.length)
    await removePayloads(
      dataRoot,
      await store.remove(excess.map((entry) => entry.id)),
    );
  return { kind: "replaced", version };
}

/** History of the file at `absolute`, newest first; empty for folders. */
async function history(store: FileVersionStore, absolute: string) {
  const current = await identity(absolute);
  return current ? store.list(current.key) : [];
}

/** A version of the file at `absolute`, or null if it belongs to another file. */
async function find(store: FileVersionStore, absolute: string, id: string) {
  const [current, version] = await Promise.all([
    identity(absolute),
    store.get(id),
  ]);
  return current && version?.fileKey === current.key
    ? { version, payload: (dataRoot: string) => payloadPath(dataRoot, id) }
    : null;
}

/**
 * Restore a version by replacing the live file with an independent copy of it
 * (a reflink where supported), which itself keeps the current content as a
 * version. The restored version stays in history.
 */
async function restore({
  store,
  dataRoot,
  target,
  id,
  archivedBy,
}: {
  store: FileVersionStore;
  dataRoot: string;
  target: string;
  id: string;
  archivedBy: string | null;
}) {
  const found = await find(store, target, id);
  if (!found) return { kind: "not-found" } as const;
  const staging = path.join(dataRoot, ".nimbus", "uploads");
  await mkdir(staging, { recursive: true });
  const incoming = path.join(staging, `${randomUUID()}.restore`);
  try {
    // Never link: the live file must not share an inode with its own history.
    await copyFile(
      found.payload(dataRoot),
      incoming,
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
    );
    return await commitReplacement({
      store,
      dataRoot,
      target,
      incoming,
      archivedBy,
    });
  } finally {
    await rm(incoming, { force: true });
  }
}

/** Discard the history of every file under `absolute`, before deleting it permanently. */
async function discardTree(
  store: FileVersionStore,
  dataRoot: string,
  absolute: string,
) {
  const keys: string[] = [];
  const pending = [absolute];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    let stats;
    try {
      stats = await lstat(next, { bigint: true });
    } catch (error) {
      if (isFsError(error, "ENOENT")) continue;
      throw error;
    }
    if (stats.isFile()) keys.push(fileKey(stats));
    else if (stats.isDirectory())
      for (const child of await readdir(next))
        pending.push(path.join(next, child));
  }
  for (let index = 0; index < keys.length; index += 500)
    await removePayloads(
      dataRoot,
      await store.removeFileKeys(keys.slice(index, index + 500)),
    );
}

/**
 * Remove versions past the age limit, and payloads left without a record by an
 * interrupted save once they are a day old.
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
  commitReplacement,
  history,
  find,
  restore,
  discardTree,
  cleanup,
} as const;
