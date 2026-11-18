import { TRPCError } from "@trpc/server";
import {
  closeSync,
  constants,
  createWriteStream,
  fstatSync,
  openSync,
  type Stats,
} from "node:fs";
import {
  copyFile,
  lstat,
  open,
  rename,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { getDataRoot } from "./data-root";
import { DescriptorPath } from "./descriptor-path";
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

const descriptorPaths = DescriptorPath.available;

const swapped = () =>
  new TRPCError({
    code: "FORBIDDEN",
    message:
      "Symbolic links cannot be accessed through Nimbus. Part of this path was replaced by one; refresh the folder.",
  });

/** Whether descriptor `fd` opened the file at `absolute`, a path inside `dataRoot`. */
async function opensPath(
  fd: number,
  absolute: string,
  stats: Stats,
  dataRoot: string,
) {
  const relative = path.relative(dataRoot, absolute);
  // On case-insensitive storage a path spelled differently from the disk may be refused,
  // as grants match only the spelling Nimbus lists.
  if (descriptorPaths)
    return DescriptorPath.opened(fd, stats, dataRoot, relative);
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
    if (!(await opensPath(handle.fd, absolute, stats, dataRoot)))
      throw swapped();
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
    await copyFile(DescriptorPath.of(opened.handle.fd), destination, mode);
    return;
  }
  await pipeline(
    opened.handle.createReadStream({ start: 0, autoClose: false }),
    createWriteStream(destination, { flags: "wx" }),
  );
}

/**
 * The device and inode of the file or folder at `absolute`, opened as `openForReading` does,
 * or null when nothing is there or it cannot be opened that way. On Linux the open, fstat
 * and close run synchronously: they name a path the caller is renaming that moment, so its
 * folders are cached, and three thread-pool round trips per rename would cost more.
 */
async function identify(absolute: string, dataRoot: string) {
  if (!descriptorPaths) {
    const opened = await openForReading(absolute, dataRoot).catch(() => null);
    if (!opened) return null;
    await opened.handle.close();
    return { dev: opened.stats.dev, ino: opened.stats.ino };
  }
  let fd: number;
  try {
    fd = openSync(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return null;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() && !stats.isDirectory()) return null;
    if (!(await opensPath(fd, absolute, stats, dataRoot))) return null;
    return { dev: stats.dev, ino: stats.ino };
  } finally {
    closeSync(fd);
  }
}

/**
 * Rename `from` to `to`, both inside `dataRoot`, and check through descriptors that the item
 * renamed was the one at `from` and that it arrived at `to`. Renames go by name, so a folder on
 * either path swapped for a symlink just before the rename would redirect it; the check catches
 * that afterwards and moves the item back. It cannot keep a redirected rename from replacing a
 * file elsewhere in that moment: that needs renameat with folder descriptors, which Bun lacks.
 */
async function renameChecked(
  from: string,
  to: string,
  dataRoot = getDataRoot(),
) {
  const moving = await identify(from, dataRoot);
  if (!moving) {
    // Gone, or reached through a symlink: find out which, as an open reports it.
    const opened = await openForReading(from, dataRoot);
    await opened.handle.close();
    throw swapped();
  }
  await rename(from, to);
  const landed = await identify(to, dataRoot);
  if (landed?.dev === moving.dev && landed.ino === moving.ino) return;
  const restored = await rename(to, from).then(
    () => true,
    () => false,
  );
  throw new TRPCError({
    code: "FORBIDDEN",
    message: restored
      ? "Part of this path was replaced by a symbolic link while Nimbus changed it, so the change was undone. Symbolic links cannot be accessed through Nimbus; refresh the folder."
      : "Part of this path was replaced by a symbolic link while Nimbus changed it, and the item could not be put back. Ask a server administrator to check both locations on the server.",
  });
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
  renameChecked,
  identityAt: identify,
  swapped,
} as const;
