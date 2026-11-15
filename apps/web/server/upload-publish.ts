import { mkdir } from "node:fs/promises";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import { getDataRoot } from "@nimbus/api/data-root";
import { publishFileEvent } from "@nimbus/api/file-events";
import {
  requireUnlocked,
  type MutationCredentials,
} from "@nimbus/api/file-mutations";
import { numberedName } from "@nimbus/api/numbered-name";
import { requireExisting, safePath } from "@nimbus/api/file-operations";
import { isApiError, isFsError } from "@nimbus/api/safe-path";
import { UploadStore } from "./upload-store";

/** Staged tus uploads expire, with their reservations, after this long. */
export const uploadStagingLifetimeMs = 24 * 60 * 60 * 1000;

/**
 * The staging store for every tus endpoint. Signed-in uploads and file
 * requests share its directory, retention and hardlink publishing. The store
 * keeps its state on disk, so each route bundle may hold its own instance.
 */
export async function uploadStaging() {
  const directory = path.join(getDataRoot(), ".nimbus", "uploads");
  await mkdir(directory, { recursive: true });
  return new UploadStore({
    directory,
    expirationPeriodInMilliseconds: uploadStagingLifetimeMs,
  });
}

/** What to do when the uploaded name is already taken in its folder. */
export type UploadConflict = "keep-both" | "replace";

export type PublishResult =
  | { kind: "published"; path: string; replaced: boolean }
  | { kind: "already-published" };

/**
 * Put a staged upload at `destination`, replacing the file there. This is the
 * single commit point for replacing content through an upload.
 */
async function replaceWithUpload(
  store: UploadStore,
  uploadId: string,
  destination: string,
) {
  await store.replace(uploadId, destination);
  publishFileEvent({ path: destination, event: "change", ts: Date.now() });
}

/**
 * Publish a completed upload into `folder`. A taken name gets " (n)" added,
 * unless `conflict` is `replace`, which replaces an existing file but never a
 * folder. Both tus servers call this inside `mutateFiles`, after their own
 * authorization, so commits are serialized and locks apply.
 */
export async function publishUpload({
  store,
  uploadId,
  filename,
  folder,
  conflict,
  credentials,
  requireWrite,
}: {
  store: UploadStore;
  uploadId: string;
  filename: string;
  folder: string;
  conflict: UploadConflict;
  credentials: MutationCredentials;
  /** Throws when the uploader may not write `relative`. */
  requireWrite: (relative: string) => void;
}): Promise<PublishResult> {
  requireWrite(folder);
  const parent = await requireExisting(folder);
  if (!parent.stats.isDirectory())
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Upload destination must be a folder.",
    });
  if (await store.isFinished(uploadId)) return { kind: "already-published" };
  for (let index = 0; ; index++) {
    const destination = await safePath(
      [folder, numberedName(filename, index, true)].filter(Boolean).join("/"),
    );
    requireWrite(destination.relative);
    requireUnlocked([destination.relative], credentials);
    let existing: Awaited<ReturnType<typeof requireExisting>> | null = null;
    try {
      existing = await requireExisting(destination.relative);
    } catch (error) {
      if (!isApiError(error, "NOT_FOUND")) throw error;
    }
    if (existing && conflict === "replace") {
      if (!existing.stats.isFile())
        throw new TRPCError({
          code: "CONFLICT",
          message: `A folder named “${filename}” already exists here. Uploads cannot replace folders; rename the file or keep both.`,
        });
      await replaceWithUpload(store, uploadId, destination.absolute);
      return { kind: "published", path: destination.relative, replaced: true };
    }
    if (existing && !(await store.isPublishedAt(uploadId, destination.absolute)))
      continue;
    try {
      await store.publish(uploadId, destination.absolute);
    } catch (error) {
      if (isFsError(error, "EEXIST")) continue;
      throw error;
    }
    publishFileEvent({
      path: destination.absolute,
      event: "rename",
      ts: Date.now(),
    });
    return { kind: "published", path: destination.relative, replaced: false };
  }
}
