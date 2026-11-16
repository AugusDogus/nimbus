import { TRPCError } from "@trpc/server";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import type { Access } from "@nimbus/api/access";
import type { FileVersionStore } from "@nimbus/api/file-versions";
import { publishFileEvent } from "@nimbus/api/file-events";
import { mutateFiles, requireUnlocked } from "@nimbus/api/file-mutations";
import { fileNameSchema } from "@nimbus/api/file-name";
import { requireExisting, safePath } from "@nimbus/api/file-operations";
import { isApiError, isFsError } from "@nimbus/api/safe-path";
import { publishUpload, type PublishResult } from "@/server/upload-publish";
import type { UploadStore } from "@/server/upload-store";

/** What to do when the uploaded name is already taken in its folder. */
export const UploadConflict = z.enum(["keep-both", "replace"]);
export type UploadConflict = z.infer<typeof UploadConflict>;

const folderSchema = z
  .string()
  .default("")
  .refine(
    (folder) =>
      folder === "" ||
      folder
        .split("/")
        .every(
          (segment) =>
            fileNameSchema.safeParse(segment).success &&
            segment === segment.trim(),
        ),
    "Folder uploads must use relative folder names without empty, reserved, or traversal segments.",
  );

/** tus metadata as stored with each upload. Values arrive as strings from the client. */
export const UploadMetadata = z.object({
  filename: fileNameSchema,
  targetPath: z.string(),
  /** Folders to recreate under `targetPath`, for folder uploads. */
  folder: folderSchema,
  conflict: UploadConflict.default("keep-both"),
  owner: z.string().min(1),
});
export type UploadMetadata = z.infer<typeof UploadMetadata>;

const join = (...segments: string[]) => segments.filter(Boolean).join("/");

async function ensureFolders(
  access: Access,
  base: string,
  folder: string,
  userId: string,
) {
  let current = base;
  for (const segment of folder ? folder.split("/") : []) {
    current = join(current, segment);
    const target = await safePath(current);
    try {
      const existing = await requireExisting(current);
      if (existing.stats.isDirectory()) continue;
      throw new TRPCError({
        code: "CONFLICT",
        message: `A file named “${segment}” is in the way of this folder upload. Rename it or upload into another folder.`,
      });
    } catch (error) {
      if (!isApiError(error, "NOT_FOUND")) throw error;
    }
    access.require(target.relative, "write");
    requireUnlocked([target.relative], { userId });
    try {
      await mkdir(target.absolute);
    } catch (error) {
      if (!isFsError(error, "EEXIST")) throw error;
    }
    publishFileEvent({
      path: target.absolute,
      event: "rename",
      ts: Date.now(),
    });
  }
  return current;
}

/**
 * Move a finished upload into the drive. Runs in the mutation queue and re-checks access, so
 * permission or lock changes during the transfer apply. Replacing never targets a folder.
 */
export async function commitUpload(
  store: UploadStore,
  versions: FileVersionStore,
  id: string,
  metadata: UploadMetadata,
  authorize: () => Promise<Access>,
): Promise<PublishResult> {
  // Held: the upload's destination folder, where folders are created and a free name chosen.
  const destination = await safePath(metadata.targetPath);
  return mutateFiles(
    [],
    { userId: metadata.owner },
    async () => {
      const access = await authorize();
      if (access.user.id !== metadata.owner)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "This upload belongs to another user.",
        });
      const target = await safePath(metadata.targetPath);
      access.require(target.relative, "write");
      const parent = await requireExisting(target.relative);
      if (!parent.stats.isDirectory())
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Upload destination must be a folder.",
        });
      const folder = await ensureFolders(
        access,
        target.relative,
        metadata.folder,
        access.user.id,
      );
      return publishUpload({
        store,
        versions,
        uploadId: id,
        filename: metadata.filename,
        folder,
        conflict:
          metadata.conflict === "replace"
            ? { kind: "replace", archivedBy: access.user.id }
            : { kind: "keep-both" },
        credentials: { userId: access.user.id },
        requireWrite: (relative) => access.require(relative, "write"),
      });
    },
    { within: [destination.relative] },
  );
}
