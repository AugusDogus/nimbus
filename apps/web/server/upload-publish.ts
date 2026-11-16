import { mkdir } from "node:fs/promises";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import { getDataRoot } from "@nimbus/api/data-root";
import { publishFileEvent } from "@nimbus/api/file-events";
import {
  requireUnlocked,
  type MutationCredentials,
} from "@nimbus/api/file-mutations";
import { FileVersions, type FileVersionStore } from "@nimbus/api/file-versions";
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

/**
 * What to do when the uploaded name is already taken in its folder: number the
 * new file, or replace the existing file and keep its content as a version.
 */
export type PublishConflict =
  | { kind: "keep-both" }
  | { kind: "replace"; versions: FileVersionStore; archivedBy: string };

export type PublishResult =
  | { kind: "published"; path: string; replaced: boolean }
  | { kind: "already-published" };

/**
 * Put a staged upload at `destination`, replacing the file there. This is the
 * single commit point for replacing content through an upload: the previous
 * content is kept as a version before the new content takes its place.
 */
async function replaceWithUpload(
  store: UploadStore,
  uploadId: string,
  destination: string,
  conflict: Extract<PublishConflict, { kind: "replace" }>,
) {
  await store.replace(uploadId, destination, (incoming) =>
    FileVersions.commitReplacement({
      store: conflict.versions,
      dataRoot: getDataRoot(),
      target: destination,
      incoming,
      archivedBy: conflict.archivedBy,
    }),
  );
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
  conflict: PublishConflict;
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
    if (existing && conflict.kind === "replace") {
      if (!existing.stats.isFile())
        throw new TRPCError({
          code: "CONFLICT",
          message: `A folder named “${filename}” already exists here. Uploads cannot replace folders; rename the file or keep both.`,
        });
      await replaceWithUpload(store, uploadId, destination.absolute, conflict);
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

/**
 * Runs each upload's publish step at most once at a time, since tus completion
 * (PATCH) and recovery (HEAD) can race. Shared by both tus servers.
 */
export function createUploadFinisher(store: UploadStore) {
  const pending = new Map<string, Promise<void>>();
  const finish = async (id: string, publish: () => Promise<void>) => {
    const existing = pending.get(id);
    if (existing) return existing;
    const task = publish();
    pending.set(id, task);
    try {
      await task;
    } finally {
      pending.delete(id);
    }
  };
  return {
    finish,
    /**
     * A fully received upload whose publish failed would otherwise look
     * finished to a resuming client, which would then report success for a
     * file that is not in the drive. On HEAD, publish it now, or throw so the
     * client retries.
     */
    async recover(
      request: Request,
      id: string,
      publish: (metadata: Record<string, string | null> | undefined) => Promise<void>,
    ) {
      if (request.method !== "HEAD" || (await store.isFinished(id))) return;
      const staged = await store.getUpload(id);
      if (staged.size !== undefined && staged.offset === staged.size)
        await finish(id, () => publish(staged.metadata));
    },
  };
}
