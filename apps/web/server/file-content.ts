import type { Stats } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { getAccess, type Access } from "@nimbus/api/access";
import { getDataRoot } from "@nimbus/api/data-root";
import type { DriveStore } from "@nimbus/api/drive-store";
import { publishFileEvent } from "@nimbus/api/file-events";
import { FileVersions } from "@nimbus/api/file-versions";
import { mutateFiles } from "@nimbus/api/file-mutations";
import { requireExisting, safePath } from "@nimbus/api/file-operations";

/** The validator served with every file response and checked before overwrites. */
export const fileETag = (stats: Pick<Stats, "mtimeMs" | "size">) =>
  `"${stats.mtimeMs}-${stats.size}"`;

export const MAX_EDIT_BYTES = 5 * 1024 * 1024;

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

async function receive(body: ReadableStream<Uint8Array>, maxBytes: number) {
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
          message: `Edited files can be at most ${Math.round(maxBytes / 1024 / 1024)} MB. The file on the server is unchanged. Download it and edit it on your device instead.`,
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
  return temporary;
}

/**
 * Replace an existing file's bytes when its current ETag equals `ifMatch`.
 * This is the browser editor's single write commit point: the body is staged
 * outside the queue, then permissions, WebDAV locks and the precondition are
 * checked and the file is atomically replaced inside it, keeping the previous
 * content as a version.
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
  const temporary = await receive(body, maxBytes);
  try {
    return await mutateFiles(
      [target.relative],
      { userId: access.user.id },
      async () => {
        const current = await getAccess(store, access.user.id);
        current.require(target.relative, "write");
        const existing = await requireExisting(target.relative);
        if (!existing.stats.isFile())
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Only files can be edited. Choose a file and try again.",
          });
        if (ifMatch !== "*" && ifMatch !== fileETag(existing.stats))
          throw new PreconditionFailedError();
        // The replaced content is kept as a version of the file.
        await FileVersions.commitReplacement({
          store: store.versions,
          dataRoot: getDataRoot(),
          target: existing.absolute,
          incoming: temporary,
          archivedBy: current.user.id,
        });
        publishFileEvent({
          path: existing.absolute,
          event: "change",
          ts: Date.now(),
        });
        const saved = await requireExisting(target.relative);
        return {
          etag: fileETag(saved.stats),
          size: saved.stats.size,
          mtime: saved.stats.mtimeMs,
        };
      },
    );
  } finally {
    await rm(temporary, { force: true });
  }
}
