import type { Stats } from "node:fs";
import { EditLimits } from "@/lib/edit-limits";
import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { getAccess, type Access } from "@nimbus/api/access";
import { getDataRoot } from "@nimbus/api/data-root";
import type { DriveStore } from "@nimbus/api/drive-store";
import {
  commitStagedFile,
  fileTag,
  type StagedFile,
} from "@nimbus/api/file-content";
import { safePath } from "@nimbus/api/file-operations";

/** The validator served with every file response and checked before overwrites. */
export const fileETag = (stats: Pick<Stats, "mtimeMs" | "size">) =>
  fileTag({ mtime: stats.mtimeMs, size: stats.size });

export const MAX_EDIT_BYTES = EditLimits.save;

export class PreconditionFailedError extends TRPCError {
  constructor() {
    super({
      code: "PRECONDITION_FAILED",
      message:
        "This file changed after you opened it. Your edits were not saved and the file on the server is unchanged. Copy your changes, reopen the file, and apply them again.",
    });
    this.name = "PreconditionFailedError";
  }
}

async function receive(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<StagedFile> {
  const directory = path.join(getDataRoot(), ".nimbus", "uploads");
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `${randomUUID()}.edit`);
  const file = await open(temporary, "wx");
  try {
    let written = 0;
    const reader = body.getReader();
    for (
      let read = await reader.read();
      !read.done;
      read = await reader.read()
    ) {
      const chunk = read.value;
      written += chunk.byteLength;
      if (written > maxBytes) {
        await reader.cancel();
        throw new TRPCError({
          code: "PAYLOAD_TOO_LARGE",
          message:
            maxBytes === EditLimits.save
              ? EditLimits.tooLarge()
              : `Edited files can be at most ${EditLimits.megabytes(maxBytes)} MB. The file on the server is unchanged. Shorten the text, or download the file and edit it on your device.`,
        });
      }
      await file.write(chunk);
    }
    await file.sync();
  } catch (error) {
    await file.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await file.close();
  return { path: temporary, discard: () => rm(temporary, { force: true }) };
}

/**
 * Replace an existing file's bytes when its current ETag equals `ifMatch`.
 * The body is staged outside the queue, then committed through the shared
 * staged-write path, which checks permissions, WebDAV locks and the
 * precondition inside it and keeps the previous content as a version.
 */
export async function saveFileContent({
  store,
  access,
  requested,
  ifMatch,
  body,
  maxBytes = MAX_EDIT_BYTES,
}: {
  store: DriveStore;
  access: Access;
  requested: string;
  ifMatch: string;
  body: ReadableStream<Uint8Array>;
  maxBytes?: number;
}) {
  const target = await safePath(requested);
  access.require(target.relative, "write");
  const staged = await receive(body, maxBytes);
  try {
    const outcome = await commitStagedFile(
      {
        userId: access.user.id,
        authorize: () => getAccess(store, access.user.id),
        drive: store,
      },
      target.relative,
      staged,
      (current) =>
        current !== null && (ifMatch === "*" || ifMatch === fileTag(current)),
    );
    switch (outcome.kind) {
      case "replaced":
        return {
          etag: fileTag(outcome.entry),
          size: outcome.entry.size,
          mtime: outcome.entry.mtime,
        };
      case "is_directory":
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only files can be edited. Choose a file and try again.",
        });
      // `accepts` refuses a missing file, so nothing is ever created here.
      case "created":
      case "missing_parent":
        throw missingFile();
      case "precondition_failed":
        if (outcome.current === null) throw missingFile();
        throw new PreconditionFailedError();
    }
  } finally {
    await staged.discard();
  }
}

const missingFile = () =>
  new TRPCError({
    code: "NOT_FOUND",
    message:
      "This file no longer exists, so your edits were not saved. Copy your changes, then reopen or recreate the file.",
  });
