import type { Stats } from "node:fs";

/**
 * Which version of a file an open descriptor reads, as a public link's proofs name it: size,
 * modification time and change time, from the descriptor's own stats. Stronger than the ETag,
 * which has only size and modification time: a program can give new content the old ones, but
 * not the old change time, which every write and every rename onto the path moves.
 *
 * Device and inode are left out on purpose. Unraid user shares (shfs, FUSE) may number inodes
 * differently after a remount, which would end every proof for content that did not change,
 * and the change time already tells a file renamed over the path from the one it replaced.
 * Birth time is left out too: some FUSE filesystems report none, and it never moves on a write.
 *
 * Fails closed, never open: anything else that moves the change time, such as a permission
 * change or a new hard link, ends the proof, and the visitor's next whole view counts again.
 * Times are milliseconds with a fractional part, exact to well under a microsecond.
 */
export type FileVersion = string;

export const FileVersion = {
  of: (stats: Pick<Stats, "size" | "mtimeMs" | "ctimeMs">): FileVersion =>
    `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`,
} as const;
