import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Access } from "./access";
import { getDataRoot } from "./data-root";
import { DriveFile } from "./drive-file";
import { entryAt, type FileEntry } from "./file-browser";
import { publishFileEvent } from "./file-events";
import { mutateFiles } from "./file-mutations";
import { FileVersions, type ContentDrive } from "./file-versions";
import { requireExisting, safePath } from "./file-operations";
import { isApiError } from "./safe-path";
import { Staging } from "./staging";

/** The entity tag WebDAV and downloads already use for a file version. */
export const fileTag = (entry: Pick<FileEntry, "mtime" | "size">) =>
  `"${entry.mtime}-${entry.size}"`;

export type TextRead =
  | {
      kind: "text";
      path: string;
      size: number;
      etag: string;
      offset: number;
      content: string;
      /** Byte offset of the next unread range, or null at the end of the file. */
      nextOffset: number | null;
    }
  | { kind: "binary"; path: string; size: number; etag: string };

const isContinuationByte = (byte: number) =>
  (byte & 0b1100_0000) === 0b1000_0000;

/** Length of `bytes` without a trailing, incomplete UTF-8 sequence. */
function completeUtf8Length(bytes: Uint8Array) {
  let start = bytes.length;
  // A UTF-8 sequence is at most four bytes, so its lead byte is within the last four.
  for (let back = 1; back <= Math.min(4, bytes.length); back++) {
    const byte = bytes[bytes.length - back];
    if (byte === undefined || !isContinuationByte(byte)) {
      start = bytes.length - back;
      break;
    }
  }
  const lead = bytes[start];
  if (lead === undefined) return bytes.length;
  const length =
    lead < 0x80
      ? 1
      : lead >= 0xf0
        ? 4
        : lead >= 0xe0
          ? 3
          : lead >= 0xc0
            ? 2
            : 1;
  return start + length <= bytes.length ? bytes.length : start;
}

/**
 * Read up to `maxBytes` of a UTF-8 text file from `offset`. Ranges end on a
 * character boundary, so consecutive reads via `nextOffset` reassemble the file.
 */
export async function readFileText(
  access: Pick<Access, "require">,
  requested: string,
  range: { offset: number; maxBytes: number },
): Promise<TextRead> {
  const target = await safePath(requested);
  access.require(target.relative, "read");
  // Stated on the open descriptor, which never follows a symlink swapped in since the check.
  const { handle, stats } = await DriveFile.openForReading(target.absolute);
  try {
    if (!stats.isFile())
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Choose a file to read. Folders have no text content.",
      });
    const size = stats.size;
    const etag = fileTag({ mtime: stats.mtimeMs, size });
    const offset = Math.min(range.offset, size);
    const buffer = new Uint8Array(Math.min(range.maxBytes, size - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0))
      return { kind: "binary", path: target.relative, size, etag };
    const first = bytes[0];
    if (first !== undefined && isContinuationByte(first))
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "This offset falls inside a multi-byte character. Start at 0 or at a nextOffset returned by a previous read.",
      });
    const complete =
      offset + bytesRead >= size ? bytes.length : completeUtf8Length(bytes);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, complete),
      );
    } catch {
      return { kind: "binary", path: target.relative, size, etag };
    }
    const end = offset + complete;
    return {
      kind: "text",
      path: target.relative,
      size,
      etag,
      offset,
      content,
      nextOffset: end >= size ? null : end,
    };
  } finally {
    await handle.close();
  }
}

export type StagedFile = { path: string; discard: () => Promise<void> };

/**
 * Write content beside the drive's upload staging area, outside any lock, so a
 * slow transfer never blocks other mutations. Commit it with `commitStagedFile`.
 * Staging on the filesystem of `destination` (an absolute path already checked with
 * `safePath`), when given, avoids a copy at commit when it is a folder mounted inside
 * the drive.
 */
export async function stageFile(
  content: string | ReadableStream<Uint8Array> | null,
  destination?: string,
): Promise<StagedFile> {
  const directory =
    destination === undefined
      ? path.join(getDataRoot(), ".nimbus", "uploads")
      : await Staging.directoryFor(getDataRoot(), destination);
  await mkdir(directory, { recursive: true });
  const staged = path.join(directory, `${randomUUID()}.staged`);
  const discard = () => rm(staged, { force: true });
  try {
    await Bun.write(staged, new Response(content));
  } catch (error) {
    await discard();
    throw error;
  }
  return { path: staged, discard };
}

export type WriteOutcome =
  | { kind: "created" | "replaced"; entry: FileEntry }
  | { kind: "precondition_failed"; current: FileEntry | null }
  | { kind: "is_directory" }
  | { kind: "missing_parent" };

/**
 * Move staged content to `requested` inside the drive's mutation lock.
 * `authorize` runs inside the lock so revoked access or disabled accounts take
 * effect before anything changes. `accepts` decides from the current entry
 * (null when absent) whether the write may proceed, e.g. If-Match semantics.
 */
export async function commitStagedFile(
  credentials: {
    userId: string;
    lockTokens?: readonly string[];
    authorize: () => Promise<Access>;
    /** Keeps the replaced content as a version, and claims the path for a new file. */
    drive: ContentDrive;
  },
  requested: string,
  staged: StagedFile,
  accepts: (current: FileEntry | null) => boolean,
): Promise<WriteOutcome> {
  const initial = await safePath(requested);
  return mutateFiles(
    [initial.relative],
    { userId: credentials.userId, lockTokens: credentials.lockTokens },
    async () => {
      const access = await credentials.authorize();
      access.require(initial.relative, "write");
      const target = await safePath(initial.relative);
      let current: FileEntry | null = null;
      try {
        current = await entryAt(target.relative);
      } catch (error) {
        if (!isApiError(error, "NOT_FOUND")) throw error;
      }
      if (current?.type === "dir") return { kind: "is_directory" };
      if (!accepts(current)) return { kind: "precondition_failed", current };
      const parent = path.posix.dirname(target.relative);
      try {
        const folder = await requireExisting(parent === "." ? "" : parent);
        if (!folder.stats.isDirectory()) return { kind: "missing_parent" };
      } catch (error) {
        if (isApiError(error, "NOT_FOUND")) return { kind: "missing_parent" };
        throw error;
      }
      // Renames only work within a filesystem; a folder may be a mount inside the drive.
      const incoming = await Staging.onFilesystemOf(
        getDataRoot(),
        staged.path,
        target.absolute,
      );
      try {
        // The single commit point for staged content: a replaced file's content is kept as a version.
        await FileVersions.commitReplacement({
          drive: credentials.drive,
          dataRoot: getDataRoot(),
          path: target.relative,
          incoming: incoming.path,
          archivedBy: access.user.id,
        });
      } finally {
        await incoming.discard();
      }
      publishFileEvent({
        path: target.absolute,
        event: current ? "change" : "rename",
        ts: Date.now(),
      });
      return {
        kind: current ? "replaced" : "created",
        entry: await entryAt(target.relative),
      };
    },
  );
}
