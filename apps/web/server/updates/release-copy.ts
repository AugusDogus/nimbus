import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  chmod,
  open,
  opendir,
  readlink,
  realpath,
  rm,
  symlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { BundleArchive } from "./bundle-archive";

/**
 * Root's copy of a staged release (see docs/updates.md, Publishing an install): the tree the
 * installer unpacked as the update user, after every process of that user was stopped, copied
 * into a new folder root owns with fixed modes. Root reads a tree a process that handled hostile
 * bytes wrote, so nothing in it is taken on trust:
 *
 * - the walk holds each folder open and opens what is in it through that descriptor
 *   (`/proc/self/fd/<fd>/<name>`), never following a link;
 * - only regular files with one link, folders and symbolic links are accepted, each owned by
 *   `owner` and without set-id or sticky bits; anything else is refused;
 * - the archive's caps hold again: entries, depth, each file's size and the total;
 * - links are recreated as links, never read through, each lexically inside the tree, and once
 *   the copy is complete every one must lead to something inside it.
 *
 * On any refusal or failure the partial copy is removed.
 */
export type CopyLimits = {
  maxEntries: number;
  maxDepth: number;
  maxFileBytes: number;
  maxTotalBytes: number;
};

const limits: CopyLimits = {
  ...BundleArchive.limits,
  maxFileBytes: BundleArchive.limits.maxTotalBytes,
};

class Refused extends Error {}

const noFollow =
  constants.O_RDONLY |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK |
  constants.O_NOCTTY;

/** Folders and files the copy creates: readable by the servers, writable by root only. */
const FOLDER_MODE = 0o755;

function checkOwnership(entry: string, stats: Stats, owner: number) {
  if (stats.uid !== owner)
    throw new Refused(
      `${entry} belongs to user ${stats.uid}, not to the update user (${owner}) who staged it`,
    );
  if (stats.mode & 0o7000)
    throw new Refused(
      `${entry} has a set-id or sticky bit, which a release never has`,
    );
}

export const ReleaseCopy = {
  limits,

  async copy(
    from: string,
    to: string,
    { owner, limits: caps }: { owner: number; limits: CopyLimits },
  ): Promise<{ ok: true; entries: number } | { ok: false; message: string }> {
    let entries = 0;
    let total = 0;
    /** One buffer for every file of the copy. */
    const buffer = new Uint8Array(1024 * 1024);
    const links: string[] = [];
    const copyFile = async (
      source: FileHandle,
      stats: Stats,
      entry: string,
      target: string,
    ) => {
      if (stats.nlink !== 1)
        throw new Refused(
          `${entry} is a hard link, which a release never holds`,
        );
      if (stats.size > caps.maxFileBytes)
        throw new Refused(
          `${entry} is ${stats.size} bytes, larger than the ${caps.maxFileBytes} a release file may be`,
        );
      total += stats.size;
      if (total > caps.maxTotalBytes)
        throw new Refused(
          `the staged release holds more than ${caps.maxTotalBytes} bytes in all`,
        );
      const out = await open(target, "wx", stats.mode & 0o111 ? 0o755 : 0o644);
      try {
        let copied = 0;
        for (;;) {
          const { bytesRead } = await source.read(
            buffer,
            0,
            buffer.length,
            copied,
          );
          if (bytesRead === 0) break;
          copied += bytesRead;
          if (copied > stats.size)
            throw new Refused(`${entry} grew while it was copied`);
          let written = 0;
          while (written < bytesRead)
            written += (
              await out.write(
                buffer,
                written,
                bytesRead - written,
                copied - bytesRead + written,
              )
            ).bytesWritten;
        }
        if (copied !== stats.size)
          throw new Refused(`${entry} changed while it was copied`);
        // Modes are fixed, whatever the process umask. No sync per file: a copy torn by a crash
        // fails the check every start makes, so it never runs.
        await out.chmod(stats.mode & 0o111 ? 0o755 : 0o644);
      } finally {
        await out.close();
      }
    };
    const walk = async (
      folder: FileHandle,
      relative: string,
      target: string,
      depth: number,
    ): Promise<void> => {
      if (depth > caps.maxDepth)
        throw new Refused(
          `${relative} is more than ${caps.maxDepth} folders deep, deeper than a release`,
        );
      // Read entry by entry, so a folder of millions stops at the cap rather than being listed.
      for await (const dirent of await opendir(`/proc/self/fd/${folder.fd}`)) {
        const name = dirent.name;
        if (++entries > caps.maxEntries)
          throw new Refused(
            `the staged release holds more than ${caps.maxEntries} entries`,
          );
        const entry = relative ? `${relative}/${name}` : name;
        const inside = `/proc/self/fd/${folder.fd}/${name}`;
        const destination = path.join(target, name);
        let handle: FileHandle;
        try {
          handle = await open(inside, noFollow);
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "ELOOP"
            )
          )
            throw error;
          // A link: recreated as one, never followed.
          const stats = await lstat(inside);
          checkOwnership(entry, stats, owner);
          const pointsTo = await readlink(inside);
          if (!BundleArchive.linkInside(entry, pointsTo))
            throw new Refused(`the link ${entry} leads outside the release`);
          await symlink(pointsTo, destination);
          links.push(entry);
          continue;
        }
        try {
          const stats = await handle.stat();
          checkOwnership(entry, stats, owner);
          if (stats.isDirectory()) {
            await mkdir(destination, { mode: FOLDER_MODE });
            // Fixed, whatever the umask.
            await chmod(destination, FOLDER_MODE);
            await walk(handle, entry, destination, depth + 1);
          } else if (stats.isFile())
            await copyFile(handle, stats, entry, destination);
          else
            throw new Refused(
              `${entry} is not a file, a folder or a link, which is all a release holds`,
            );
        } finally {
          await handle.close();
        }
      }
    };
    let made = false;
    try {
      const top = await open(from, noFollow | constants.O_DIRECTORY);
      try {
        const stats = await top.stat();
        checkOwnership("the staged release", stats, owner);
        await mkdir(to, { mode: FOLDER_MODE });
        await chmod(to, FOLDER_MODE);
        made = true;
        await walk(top, "", to, 1);
      } finally {
        await top.close();
      }
      // Every link, now in root's copy, must lead to something inside it.
      const root = await realpath(to);
      for (const entry of links) {
        const resolved = await realpath(path.join(to, entry)).catch(() => null);
        if (resolved === null)
          throw new Refused(`the link ${entry} leads nowhere`);
        if (resolved !== root && !resolved.startsWith(`${root}/`))
          throw new Refused(`the link ${entry} leads outside the release`);
      }
      return { ok: true, entries };
    } catch (error) {
      if (made) await rm(to, { recursive: true, force: true });
      return {
        ok: false,
        message:
          error instanceof Refused
            ? `The staged release was refused: ${error.message}.`
            : `The staged release could not be copied (${error instanceof Error && "code" in error ? String(error.code) : error instanceof Error ? error.message : String(error)}).`,
      };
    }
  },
} as const;
