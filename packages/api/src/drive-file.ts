import { TRPCError } from "@trpc/server";
import {
  constants,
  createWriteStream,
  existsSync,
  readlinkSync,
  type Stats,
} from "node:fs";
import {
  copyFile,
  lstat,
  open,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { getDataRoot } from "./data-root";
import { isFsError } from "./safe-path";

/**
 * Reading drive files without following symlinks.
 *
 * `resolveSafePath` checks every component of a path with lstat, but another program (an SMB
 * or NFS user, a shell) can swap a checked file or folder for a symlink before Nimbus opens it.
 * Opening by name would then follow the link to anything the server can read, such as its
 * database or another user's files. So drive files are opened here: without following a
 * symlink in the last component, without waiting for a pipe's writer, and then checked on the
 * open descriptor. Its type comes from fstat, and on Linux its location from
 * `/proc/self/fd`, which names the file the descriptor actually opened, so a symlink swapped in
 * for any folder on the way is caught too. Elsewhere the components are checked again with
 * lstat once the file is open.
 */

/** Linux exposes every open descriptor as a path that opens the same file. */
const descriptorPaths = existsSync("/proc/self/fd");

/** The data root with its own symlinks resolved, as descriptor paths name it. */
const realRoots = new Map<string, string>();
async function realRoot(dataRoot: string) {
  let real = realRoots.get(dataRoot);
  if (real === undefined) {
    real = await realpath(dataRoot);
    realRoots.set(dataRoot, real);
  }
  return real;
}

const swapped = () =>
  new TRPCError({
    code: "FORBIDDEN",
    message:
      "Symbolic links cannot be accessed through Nimbus. Part of this path was replaced by one; refresh the folder.",
  });

/** Whether `handle` opened the file at `absolute`, a path inside `dataRoot`. */
async function opensPath(
  handle: FileHandle,
  absolute: string,
  stats: Stats,
  dataRoot: string,
) {
  const relative = path.relative(dataRoot, absolute);
  if (descriptorPaths) {
    // A file renamed over or deleted since it was opened is reported with this suffix.
    // A procfs lookup that never waits on storage, so it runs synchronously, sparing a
    // thread-pool round trip on every open.
    const opened = readlinkSync(`/proc/self/fd/${handle.fd}`).replace(
      / \(deleted\)$/,
      "",
    );
    const expected = path.join(await realRoot(dataRoot), relative);
    // Case-insensitive volumes may report the name as stored on disk.
    return (
      opened === expected || opened.toLowerCase() === expected.toLowerCase()
    );
  }
  let current = dataRoot;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) return false;
  }
  const named = await lstat(absolute);
  return named.dev === stats.dev && named.ino === stats.ino;
}

export type OpenedDriveFile = { handle: FileHandle; stats: Stats };

/**
 * Open the file or folder at `absolute`, a path already checked with `safePath`, for reading.
 * Throws NOT_FOUND when it is gone and FORBIDDEN when a symlink now stands anywhere in its
 * path or it is a pipe, socket or device. The caller closes the handle.
 */
async function openForReading(
  absolute: string,
  dataRoot = getDataRoot(),
): Promise<OpenedDriveFile> {
  let handle: FileHandle;
  try {
    // O_NONBLOCK: opening a FIFO would otherwise wait for a writer. It changes nothing for files.
    handle = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR"))
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "This file or folder no longer exists. Refresh the drive.",
      });
    if (isFsError(error, "ELOOP")) throw swapped();
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() && !stats.isDirectory())
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Pipes, sockets and device files cannot be accessed through Nimbus. Only regular files and folders can.",
      });
    if (!(await opensPath(handle, absolute, stats, dataRoot))) throw swapped();
    return { handle, stats };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Open a regular drive file for reading, refusing a folder as the caller asked for a file. */
async function openFile(
  absolute: string,
  dataRoot = getDataRoot(),
): Promise<OpenedDriveFile> {
  const opened = await openForReading(absolute, dataRoot);
  if (opened.stats.isFile()) return opened;
  await opened.handle.close();
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: "This is a folder. Choose a file.",
  });
}

/**
 * Copy an opened file's content to `destination`, which must not exist. On Linux the copy
 * reads the descriptor's own path, so copy-on-write filesystems still clone extents when
 * `mode` asks for it; elsewhere the bytes are streamed from the descriptor.
 */
async function copyOpened(
  opened: OpenedDriveFile,
  destination: string,
  mode: number,
) {
  if (descriptorPaths) {
    await copyFile(`/proc/self/fd/${opened.handle.fd}`, destination, mode);
    return;
  }
  await pipeline(
    opened.handle.createReadStream({ start: 0, autoClose: false }),
    createWriteStream(destination, { flags: "wx" }),
  );
}

/** Copy the regular file at `absolute` to `destination` without following a swapped-in symlink. */
async function copy(absolute: string, destination: string, mode: number) {
  const opened = await openFile(absolute);
  try {
    await copyOpened(opened, destination, mode);
  } finally {
    await opened.handle.close();
  }
}

export const DriveFile = {
  openForReading,
  openFile,
  copyOpened,
  copy,
  swapped,
} as const;
