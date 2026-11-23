import { mkdir } from "node:fs/promises";
import { UploadLocks } from "./upload-locks";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import { getDataRoot } from "@nimbus/api/data-root";
import { publishFileEvent } from "@nimbus/api/file-events";
import {
  requireUnlocked,
  type MutationCredentials,
} from "@nimbus/api/file-mutations";
import { FileVersions, type ContentDrive } from "@nimbus/api/file-versions";
import type { FileRequestStore } from "@nimbus/api/file-request";
import { numberedName } from "@nimbus/api/numbered-name";
import { requireExisting, safePath } from "@nimbus/api/file-operations";
import { isApiError, isFsError } from "@nimbus/api/safe-path";
import { VacantPath } from "@nimbus/api/vacant-path";
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
  | { kind: "replace"; archivedBy: string };

export type PublishResult =
  | { kind: "published"; path: string; replaced: boolean }
  /** Published by an earlier attempt, at `path` when its marker names a place in the drive. */
  | { kind: "already-published"; path: string | null };

/**
 * Where an upload was published, from its completion marker: its path in the drive, or null
 * when the marker names a place outside it. "unfinished" when it was never published.
 */
export async function publishedLocation(
  store: UploadStore,
  uploadId: string,
): Promise<
  { kind: "unfinished" } | { kind: "published"; path: string | null }
> {
  const published = await store.publishedTo(uploadId);
  if (published === null) return { kind: "unfinished" };
  const relative = path.relative(getDataRoot(), published);
  return {
    kind: "published",
    path:
      relative && !relative.startsWith("..") && !path.isAbsolute(relative)
        ? relative.split(path.sep).join("/")
        : null,
  };
}

/**
 * A file request upload's ledger entry, recorded once it is published. A crash between
 * publishing and recording leaves the file published but uncounted; a resuming client's HEAD
 * finds the marker and records it here. Recording a finished upload again changes nothing.
 */
export async function recordPublishedUpload(
  store: UploadStore,
  fileRequests: Pick<FileRequestStore, "finishUpload">,
  uploadId: string,
) {
  const published = await publishedLocation(store, uploadId);
  if (published.kind === "unfinished") return;
  const name =
    published.path ??
    (await store.getUpload(uploadId)).metadata?.filename ??
    uploadId;
  await fileRequests.finishUpload(uploadId, name, Date.now());
}

/**
 * Put a staged upload at `destination`, replacing the file there. This is the
 * single commit point for replacing content through an upload: the previous
 * content is kept as a version before the new content takes its place.
 */
async function replaceWithUpload(
  store: UploadStore,
  drive: ContentDrive,
  uploadId: string,
  destination: { absolute: string; relative: string },
  conflict: Extract<PublishConflict, { kind: "replace" }>,
) {
  await store.replace(uploadId, destination.absolute, (incoming) =>
    FileVersions.commitReplacement({
      drive,
      dataRoot: getDataRoot(),
      path: destination.relative,
      incoming,
      archivedBy: conflict.archivedBy,
    }),
  );
  publishFileEvent({
    path: destination.absolute,
    event: "change",
    ts: Date.now(),
  });
}

/**
 * Publish a completed upload into `folder`. A taken name gets " (n)" added,
 * unless `conflict` is `replace`, which replaces an existing file but never a
 * folder. Both tus servers call this inside `mutateFiles`, after their own
 * authorization, so commits are serialized and locks apply.
 */
export async function publishUpload({
  store,
  drive,
  uploadId,
  filename,
  folder,
  conflict,
  credentials,
  requireWrite,
}: {
  store: UploadStore;
  /** Keeps a replaced file's content as a version, and claims new paths. */
  drive: ContentDrive;
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
  const published = await publishedLocation(store, uploadId);
  if (published.kind === "published")
    return { kind: "already-published", path: published.path };
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
      await replaceWithUpload(store, drive, uploadId, destination, conflict);
      return { kind: "published", path: destination.relative, replaced: true };
    }
    if (existing) {
      // Taken, unless an earlier attempt published this upload there before failing.
      if (!(await store.isPublishedAt(uploadId, destination.absolute)))
        continue;
    } else if (
      // Records left by content removed outside Nimbus never attach to the new file.
      (await VacantPath.claim(drive, destination)).kind === "occupied"
    )
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
 * (PATCH) and recovery (HEAD) can race, also on two server processes during an update: it
 * holds the upload's lock (UploadLocks), which no PATCH writes without, and publishes only an
 * upload that is complete and not yet published. Shared by both tus servers.
 */
export function createUploadFinisher(store: UploadStore) {
  const pending = new Map<string, Promise<void>>();
  const finish = async (id: string, publish: () => Promise<void>) => {
    const existing = pending.get(id);
    if (existing) return existing;
    const task = UploadLocks.hold(id, async () => {
      if (await store.isFinished(id)) return;
      const staged = await store.getUpload(id);
      if (staged.size === undefined || staged.offset !== staged.size) return;
      await publish();
    });
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
     * client retries. `publish` must publish through `finish`.
     */
    async recover(
      request: Request,
      id: string,
      publish: (
        metadata: Record<string, string | null> | undefined,
      ) => Promise<void>,
    ) {
      if (request.method !== "HEAD" || (await store.isFinished(id))) return;
      const staged = await store.getUpload(id);
      // `publish` goes through `finish` itself, which holds the lock and checks again.
      if (staged.size !== undefined && staged.offset === staged.size)
        await publish(staged.metadata);
    },
  };
}
