import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import path from "node:path";

/**
 * A release tree's digest (see docs/updates.md): SHA-256 of a canonical listing of every entry,
 * sorted by path, one line each: `f <mode> <size> <content SHA-256> <path>` for a file (mode 755
 * when executable, else 644), `d <path>` for a folder, `l <target> <path>` for a link. The
 * manifest carries the digest of the tree the bundle was built from, so an installed release is
 * checked against what was signed: a changed, missing or extra file or link changes the digest.
 */
export const ReleaseTree = {
  /** The digest of the tree at `root`, leaving out the relative paths in `exclude`. */
  async digest(root: string, exclude: ReadonlySet<string> = new Set()) {
    const listing = createHash("sha256");
    let entries = 0;
    /** One buffer for every file of the walk. */
    const buffer = new Uint8Array(1024 * 1024);
    const walk = async (relative: string): Promise<void> => {
      const names = (await readdir(path.join(root, relative))).sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      for (const name of names) {
        const entry = relative ? `${relative}/${name}` : name;
        if (exclude.has(entry)) continue;
        const absolute = path.join(root, entry);
        const stats = await lstat(absolute);
        entries++;
        if (stats.isSymbolicLink())
          listing.update(
            `l ${JSON.stringify(await readlink(absolute))} ${JSON.stringify(entry)}\n`,
          );
        else if (stats.isDirectory()) {
          listing.update(`d ${JSON.stringify(entry)}\n`);
          await walk(entry);
        } else if (stats.isFile()) {
          const content = createHash("sha256");
          // Opened without following a link, should one have taken the file's place.
          const file = await open(
            absolute,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            if (!(await file.stat()).isFile())
              throw new Error(`${entry} changed while it was checked`);
            for (let position = 0; ;) {
              const { bytesRead } = await file.read(
                buffer,
                0,
                buffer.length,
                position,
              );
              if (bytesRead === 0) break;
              content.update(buffer.subarray(0, bytesRead));
              position += bytesRead;
            }
          } finally {
            await file.close();
          }
          listing.update(
            `f ${stats.mode & 0o111 ? 755 : 644} ${stats.size} ${content.digest("hex")} ${JSON.stringify(entry)}\n`,
          );
        } else listing.update(`? ${JSON.stringify(entry)}\n`);
      }
    };
    await walk("");
    return { sha256: listing.digest("hex"), entries };
  },
} as const;
