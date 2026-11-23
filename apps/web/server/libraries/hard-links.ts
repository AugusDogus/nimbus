import type { Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { getDataRoot } from "@nimbus/api/data-root";

/**
 * Files with more than one name. A second name of a file inside a library could be anywhere,
 * such as in a folder the library does not offer, and the descriptor check proves only the name
 * that was opened. So a library offers a file with several names only when every other name is
 * Nimbus's own: upload staging in `<data root>/.nimbus/uploads`, which keeps a published upload's
 * staging name for up to a day. Any other name, wherever it is, keeps the file out of libraries.
 */
export type StagedNames = Map<string, number>;

const key = (stats: Pick<Stats, "dev" | "ino">) => `${stats.dev}:${stats.ino}`;

/** How many names in upload staging each file has, by device and inode. */
async function staged(root = getDataRoot()): Promise<StagedNames> {
  const directory = path.join(root, ".nimbus", "uploads");
  const names = new Map<string, number>();
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return names;
  }
  for (const entry of entries) {
    const stats = await lstat(path.join(directory, entry)).catch(() => null);
    if (stats?.isFile())
      names.set(key(stats), (names.get(key(stats)) ?? 0) + 1);
  }
  return names;
}

/** Whether a regular file described by `stats` may be offered, given the staged names. */
const offered = (
  stats: Pick<Stats, "dev" | "ino" | "nlink">,
  names: StagedNames,
) => stats.nlink <= 1 || stats.nlink - 1 === (names.get(key(stats)) ?? 0);

export const HardLinks = { staged, offered } as const;
