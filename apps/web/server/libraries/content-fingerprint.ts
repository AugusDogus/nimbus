import { createHash } from "node:crypto";
import { DriveFile } from "@nimbus/api/drive-file";
import { isApiError, PathError, resolveSafePath } from "@nimbus/api/safe-path";

/**
 * A cheap fingerprint of a file's content, for recognizing a file that moved or came back: its
 * size and a SHA-256 over the first, middle and last 64 KiB, or over the whole file when it is
 * smaller than those three samples. It reads at most 192 KiB of any file, through the same
 * no-follow descriptor open every library read uses. Not proof of identical content, only
 * strong evidence when size, modification time and fingerprint all agree.
 */
export type ContentFingerprint = string;

const sampleBytes = 64 * 1024;

/** The regions sampled from a file of `size` bytes, as [offset, length] pairs. */
function samples(size: number): [number, number][] {
  if (size <= 3 * sampleBytes) return [[0, size]];
  return [
    [0, sampleBytes],
    [Math.floor((size - sampleBytes) / 2), sampleBytes],
    [size - sampleBytes, sampleBytes],
  ];
}

/**
 * The fingerprint of the regular file at drive path `path`, or null when it is gone, is not a
 * regular file, is reached through a symbolic link, or no longer has the size and whole-millisecond
 * modification time the caller saw, as when it changed since it was scanned.
 */
async function of(
  path: string,
  expected: { sizeBytes: number; modifiedAt: number },
): Promise<ContentFingerprint | null> {
  let opened;
  try {
    opened = await DriveFile.openForReading(
      (await resolveSafePath(path)).absolute,
    );
  } catch (error) {
    if (
      error instanceof PathError ||
      isApiError(error, "NOT_FOUND") ||
      isApiError(error, "FORBIDDEN")
    )
      return null;
    throw error;
  }
  try {
    const { stats } = opened;
    if (
      !stats.isFile() ||
      stats.size !== expected.sizeBytes ||
      Math.floor(stats.mtimeMs) !== expected.modifiedAt
    )
      return null;
    const hash = createHash("sha256").update(`${stats.size}\0`);
    for (const [offset, length] of samples(stats.size)) {
      const buffer = new Uint8Array(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await opened.handle.read(
          buffer,
          read,
          length - read,
          offset + read,
        );
        if (bytesRead === 0) return null;
        read += bytesRead;
      }
      hash.update(buffer);
    }
    return `fp1_${hash.digest("base64url").slice(0, 32)}`;
  } finally {
    await opened.handle.close();
  }
}

export const ContentFingerprint = { of, samples } as const;
