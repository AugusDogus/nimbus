import type { BigIntStatsFs } from "node:fs";
import { statfs } from "node:fs/promises";

export type FilesystemCapacity = {
  totalBytes: number;
  availableBytes: number;
};

function fromStats(
  stats: Pick<BigIntStatsFs, "bsize" | "blocks" | "bavail">,
): FilesystemCapacity | null {
  const zero = BigInt(0);
  const totalBytes = stats.bsize * stats.blocks;
  // Available blocks exclude filesystem reserves. A full disk may report a negative count.
  const availableBytes =
    stats.bavail > zero ? stats.bsize * stats.bavail : zero;
  if (
    stats.bsize <= zero ||
    totalBytes <= zero ||
    totalBytes > BigInt(Number.MAX_SAFE_INTEGER) ||
    availableBytes > totalBytes
  )
    return null;
  return {
    totalBytes: Number(totalBytes),
    availableBytes: Number(availableBytes),
  };
}

/**
 * Bytes that may still be promised to writes that land on every one of `filesystems`, keeping
 * `floor(totalBytes)` free on each: the least any of them can spare. Null when none was read.
 */
function spareBytes(
  filesystems: readonly (FilesystemCapacity | null)[],
  floor: (totalBytes: number) => number,
): number | null {
  const spare = filesystems.flatMap((capacity) =>
    capacity ? [capacity.availableBytes - floor(capacity.totalBytes)] : [],
  );
  return spare.length ? Math.min(...spare) : null;
}

/** Free space a write must leave on a filesystem: the larger of 1 GiB and 5% of the disk. */
const minimumFreeBytes = (totalBytes: number) =>
  Math.max(1024 ** 3, totalBytes * 0.05);

export const FilesystemCapacity = {
  fromStats,
  spareBytes,
  minimumFreeBytes,
  /** Host filesystem capacity, shared with other applications, not a Nimbus quota. */
  async read(directory: string): Promise<FilesystemCapacity | null> {
    try {
      return fromStats(await statfs(directory, { bigint: true }));
    } catch {
      // Capacity is optional on platforms/filesystems where statfs is unavailable.
      return null;
    }
  },
} as const;
