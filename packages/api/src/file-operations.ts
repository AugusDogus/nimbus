import { TRPCError } from "@trpc/server";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { accessFor, getAccess, type Access } from "./access";
import { readDirectory } from "./file-browser";
import { Homes } from "./homes";
import {
  forgetFileLocks,
  mutateFiles,
  type MutationCredentials,
} from "./file-mutations";
import { getDataRoot } from "./data-root";
import type { DriveStore, TrashItem } from "./drive-store";
import { publishFileEvent } from "./file-events";
import { auditUser, recordAudit } from "./audit";
import { FileVersions } from "./file-versions";
import { DriveFile } from "./drive-file";
import {
  isApiError,
  isFsError,
  isWithinPath,
  PathError,
  resolveSafePath,
} from "./safe-path";
import { PendingChanges } from "./pending-changes";
import { Staging } from "./staging";
import { VacantPath } from "./vacant-path";

export async function safePath(requested: string) {
  try {
    return await resolveSafePath(requested);
  } catch (error) {
    if (error instanceof PathError)
      throw new TRPCError({ code: error.code, message: error.message });
    throw error;
  }
}

/** The file or folder at a drive path. Pipes, sockets and devices are refused like symlinks. */
export async function requireExisting(requested: string) {
  const target = await safePath(requested);
  let stats: Stats;
  try {
    stats = await lstat(target.absolute);
  } catch (error) {
    if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR"))
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "This file or folder no longer exists. Refresh the drive.",
      });
    throw error;
  }
  // Opening a pipe would wait for a writer, and devices are not drive content.
  if (!stats.isFile() && !stats.isDirectory())
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Pipes, sockets and device files cannot be accessed through Nimbus. Only regular files and folders can.",
    });
  return { ...target, stats };
}

export async function requireUnused(absolute: string) {
  try {
    await lstat(absolute);
  } catch (error) {
    if (isFsError(error, "ENOENT")) return;
    throw error;
  }
  throw new TRPCError({
    code: "CONFLICT",
    message: "An item with that name already exists. Choose another name.",
  });
}

export function requireMutable(relative: string) {
  if (!relative)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The drive root cannot be renamed, moved, or deleted.",
    });
}

/**
 * How a move or copy treats an existing destination. WebDAV clients choose with the
 * `Overwrite` header (RFC 4918, section 10.6); the browser never replaces.
 */
export type ExistingDestination = "refuse" | "replace";
export type TransferOptions = {
  lockTokens?: MutationCredentials["lockTokens"];
  existing?: ExistingDestination;
};
/** What happened to an existing destination: none existed, a file's content was replaced, or it went to trash. */
type Replacement =
  | { kind: "vacant" }
  | { kind: "content" }
  | { kind: "trashed"; trashId: string };

async function statOrNull(absolute: string) {
  try {
    return await lstat(absolute);
  } catch (error) {
    if (isFsError(error, "ENOENT")) return null;
    throw error;
  }
}

function requireSeparate(source: string, target: string) {
  if (isWithinPath(source, target))
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Choose a different destination outside this folder.",
    });
  if (isWithinPath(target, source))
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Choose a destination that does not contain this item. Replacing it would delete the item itself.",
    });
}

/**
 * Prepare an existing destination. A file replacing a file keeps the destination's links and
 * grants, like an upload of new content: this is what save-by-replace editors rely on when
 * they write a temporary file and move it over the original. Any other replacement sends the
 * destination to trash first, so it stays recoverable.
 */
async function prepareDestination(
  store: DriveStore,
  access: Access,
  source: Stats,
  target: { absolute: string; relative: string },
  existing: ExistingDestination,
  /** The trash id a replaced folder gets, already held by the caller's mutation scope. */
  trashId: string,
): Promise<Replacement> {
  const current = await statOrNull(target.absolute);
  if (!current) return { kind: "vacant" };
  if (existing === "refuse") await requireUnused(target.absolute);
  if (source.isFile() && current.isFile()) return { kind: "content" };
  await trashUnlocked(store, access, target.relative, trashId);
  return { kind: "trashed", trashId };
}

async function undoReplacement(
  store: DriveStore,
  access: Access,
  replacement: Replacement,
) {
  if (replacement.kind === "trashed")
    await restoreUnlocked(store, access, replacement.trashId);
}

async function moveUnlocked(
  store: DriveStore,
  access: Access,
  sourcePath: string,
  targetPath: string,
  existingDestination: ExistingDestination,
  trashId: string,
) {
  const source = await safePath(sourcePath);
  const target = await safePath(targetPath);
  requireMutable(source.relative);
  requireMutable(target.relative);
  access.require(source.relative, "write");
  access.require(target.relative, "write");
  // A moved item keeps its own links, direct grants, and bookmarks, but stops inheriting from its
  // source's ancestors and inherits from its destination's instead. That can expose a whole
  // subtree to new people, so moving a folder requires control of its sharing.
  const existing = await requireExisting(source.relative);
  if (existing.stats.isDirectory()) access.require(source.relative, "admin");
  requireSeparate(source.relative, target.relative);
  await Homes.requireNotHome(store, source.relative);
  const replacement = await prepareDestination(
    store,
    access,
    existing.stats,
    target,
    existingDestination,
    trashId,
  );
  try {
    if (replacement.kind === "content") {
      // The replaced content is kept as a version of the destination.
      await FileVersions.commitReplacement({
        drive: store,
        dataRoot: getDataRoot(),
        path: target.relative,
        incoming: source.absolute,
        archivedBy: access.user.id,
      });
      // The destination keeps its own records and history; the merged file's end with it,
      // only once its content has moved, so a failed commit leaves its sharing intact. Its
      // path is vacant now, and records left there would never attach to new content.
      await store.claimVacant(source.relative);
    } else {
      // Records under another spelling of the vacant destination never attach to the
      // arriving item; movePath drops those at its exact path in its own transaction.
      if ((await VacantPath.claim(store, target)).kind === "occupied")
        await requireUnused(target.absolute);
      // Recorded first, so startup can relocate the sharing of content that already moved.
      const pending = randomUUID();
      await store.addPendingChange({
        id: pending,
        kind: "move",
        from: source.relative,
        to: target.relative,
      });
      try {
        await rename(source.absolute, target.absolute);
      } catch (error) {
        await store.removePendingChange(pending);
        throw error;
      }
      try {
        await store.movePath(source.relative, target.relative, pending);
      } catch (error) {
        await rename(target.absolute, source.absolute);
        await store.removePendingChange(pending);
        throw error;
      }
    }
  } catch (error) {
    await undoReplacement(store, access, replacement);
    throw error;
  }
  forgetFileLocks(source.relative);
  publishFileEvent({ path: source.absolute, event: "delete", ts: Date.now() });
  publishFileEvent({
    path: target.absolute,
    event: replacement.kind === "content" ? "change" : "rename",
    ts: Date.now(),
  });
  return {
    name: path.basename(target.absolute),
    path: target.relative,
    replaced: replacement.kind !== "vacant",
  };
}

/** Copy a file or folder tree into a staging path, skipping descendants the user cannot read. */
// A clone shares extents on copy-on-write filesystems and falls back to a byte copy elsewhere.
const copyMode = constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE;
/** Files of one folder copied at once. */
const copyConcurrency = 16;

async function stageCopy(
  access: Access,
  source: { relative: string; absolute: string; stats: Stats },
  staging: string,
  depth: CopyDepth,
) {
  if (!source.stats.isDirectory()) {
    await DriveFile.copy(source.absolute, staging, copyMode);
    return;
  }
  await mkdir(staging);
  if (depth === "0") return;
  const pending = [source.relative];
  while (pending.length) {
    const directory = pending.shift();
    if (directory === undefined) break;
    const files: { from: string; to: string }[] = [];
    for (const entry of await readDirectory(directory, access)) {
      if (!access.can(entry.path, "read")) continue;
      const destination = path.join(
        staging,
        entry.path.slice(source.relative.length + 1),
      );
      if (entry.type === "dir") {
        await mkdir(destination);
        pending.push(entry.path);
      } else
        files.push({
          from: path.join(getDataRoot(), entry.path),
          to: destination,
        });
    }
    // Each file is opened and checked before it is copied; copying several at once keeps
    // that from slowing large folders down.
    let next = 0;
    const copyNext = async () => {
      for (let index = next++; index < files.length; index = next++) {
        const file = files[index];
        if (!file) continue;
        try {
          // Listed as a plain file, but opened without following a symlink swapped in since.
          await DriveFile.copy(file.from, file.to, copyMode);
        } catch (error) {
          // Entries removed or replaced by a symlink while copying are skipped, like a
          // listing taken at that moment.
          if (
            !isApiError(error, "NOT_FOUND") &&
            !isApiError(error, "FORBIDDEN")
          )
            throw error;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(copyConcurrency, files.length) }, copyNext),
    );
  }
}

/** `0` copies a folder without its contents (RFC 4918, section 9.8.3). */
export type CopyDepth = "0" | "infinity";
export type CopyOptions = TransferOptions & { depth?: CopyDepth };

/**
 * Copy an item with its WebDAV dead properties, but without links, grants, or bookmarks. Data is staged without holding
 * the mutation queue, then committed after permissions and locks are checked again.
 */
export async function copyItem(
  store: DriveStore,
  access: Access,
  sourcePath: string,
  targetPath: string,
  options: CopyOptions = {},
) {
  const requested = await safePath(sourcePath);
  const target = await safePath(targetPath);
  requireMutable(target.relative);
  // Before the source is looked up, so it does not reveal whether it exists.
  access.require(requested.relative, "read");
  access.require(target.relative, "write");
  const source = await requireExisting(requested.relative);
  requireSeparate(source.relative, target.relative);
  const existingDestination = options.existing ?? "refuse";
  if (existingDestination === "refuse") await requireUnused(target.absolute);
  // On the destination's filesystem, which a folder mounted inside the drive may not share.
  const stagingDirectory = await Staging.directoryFor(
    getDataRoot(),
    target.absolute,
  );
  const staging = path.join(stagingDirectory, `${randomUUID()}.copy`);
  const trashId = randomUUID();
  // However long the copy takes, maintenance must not clean its staging meanwhile.
  const release = Staging.hold(staging);
  try {
    await stageCopy(access, source, staging, options.depth ?? "infinity");
    return await mutateFiles(
      [target.relative],
      { userId: access.user.id, lockTokens: options.lockTokens },
      async () => {
        const current = await getAccess(store, access.user.id);
        current.require(source.relative, "read");
        current.require(target.relative, "write");
        await safePath(target.relative);
        const replacement = await prepareDestination(
          store,
          current,
          source.stats,
          target,
          existingDestination,
          trashId,
        );
        try {
          if (replacement.kind === "content")
            // The replaced content is kept as a version of the destination.
            await FileVersions.commitReplacement({
              drive: store,
              dataRoot: getDataRoot(),
              path: target.relative,
              incoming: staging,
              archivedBy: current.user.id,
            });
          else {
            // Records left by content removed outside Nimbus never attach to the copy.
            if ((await VacantPath.claim(store, target)).kind === "occupied")
              await requireUnused(target.absolute);
            await rename(staging, target.absolute);
          }
        } catch (error) {
          await undoReplacement(store, current, replacement);
          throw error;
        }
        // Dead properties describe the content, so the copy keeps them (RFC 4918, section 9.8.2).
        await store.copyDavProperties(source.relative, target.relative);
        publishFileEvent({
          path: target.absolute,
          event: replacement.kind === "content" ? "change" : "rename",
          ts: Date.now(),
        });
        return {
          path: target.relative,
          replaced: replacement.kind !== "vacant",
        };
      },
      { trash: [trashId] },
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
    release();
  }
}

async function trashUnlocked(
  store: DriveStore,
  access: Access,
  requested: string,
  /** The new trash item's id, held by the caller's mutation scope. */
  id: string,
) {
  const target = await safePath(requested);
  requireMutable(target.relative);
  access.require(target.relative, "write");
  await requireExisting(target.relative);
  await Homes.requireNotHome(store, target.relative);
  const trashDir = path.join(getDataRoot(), ".nimbus", "trash");
  await mkdir(trashDir, { recursive: true });
  const destination = path.join(trashDir, id);
  const item: TrashItem = {
    id,
    path: target.relative,
    deletedBy: access.user.id,
    deletedAt: Date.now(),
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  };
  // Recorded first, so startup can tell a trash record whose rename never ran; see PendingChanges.
  const pending = PendingChanges.trashMarker(id);
  await store.addPendingChange({ id: pending, kind: "trash", trashId: id });
  await store.addTrash(item);
  try {
    await rename(target.absolute, destination);
  } catch (error) {
    await store.restoreTrash(id);
    await store.removePendingChange(pending);
    throw error;
  }
  await store.removePendingChange(pending);
  forgetFileLocks(target.relative);
  publishFileEvent({ path: target.absolute, event: "delete", ts: Date.now() });
  recordAudit({
    action: "trash.moved",
    actor: auditUser(access.user),
    target: { type: "path", id: target.relative },
    details: { trashId: id },
  });
  return { path: target.relative, trashId: id };
}

export async function getOwnedTrash(
  store: DriveStore,
  access: Access,
  id: string,
) {
  const item = await store.getTrash(id);
  if (!item || (!access.isAdmin && item.deletedBy !== access.user.id))
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "This item is no longer in your trash.",
    });
  return item;
}

async function restoreUnlocked(store: DriveStore, access: Access, id: string) {
  const item = await getOwnedTrash(store, access, id);
  const target = await safePath(item.path);
  // Trash suspended the item's own grants, including any that let this person delete it, and
  // restoring returns them. So they count here along with the live ones.
  accessFor(access.user, [
    ...access.grants,
    ...(await store.detachedGrantsFor(id, access.user.id)),
  ]).require(target.relative, "write");
  await requireUnused(target.absolute);
  const parent = await requireExisting(
    path.posix.dirname(item.path) === "." ? "" : path.posix.dirname(item.path),
  );
  if (!parent.stats.isDirectory())
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Recreate the original parent folder before restoring this item.",
    });
  // Records under another spelling of the vacant path never attach to the restored item;
  // restoreTrash drops those at its exact path in its own transaction.
  if ((await VacantPath.claim(store, target)).kind === "occupied")
    await requireUnused(target.absolute);
  const source = path.join(getDataRoot(), ".nimbus", "trash", item.id);
  // Recorded first, so startup can finish a restore whose sharing was not yet reattached.
  const pending = PendingChanges.restoreMarker(id);
  await store.addPendingChange({ id: pending, kind: "restore", trashId: id });
  try {
    await rename(source, target.absolute);
  } catch (error) {
    await store.removePendingChange(pending);
    throw error;
  }
  try {
    await store.restoreTrash(id);
  } catch (error) {
    await rename(target.absolute, source);
    await store.removePendingChange(pending);
    throw error;
  }
  await store.removePendingChange(pending);
  publishFileEvent({ path: target.absolute, event: "rename", ts: Date.now() });
  recordAudit({
    action: "trash.restored",
    actor: auditUser(access.user),
    target: { type: "path", id: target.relative },
    details: { trashId: item.id },
  });
  return { path: target.relative };
}

async function purgeUnlocked(store: DriveStore, access: Access, id: string) {
  const item = await getOwnedTrash(store, access, id);
  const trashed = path.join(getDataRoot(), ".nimbus", "trash", item.id);
  await FileVersions.discard(
    store.versions,
    getDataRoot(),
    FileVersions.trashLocation(item.id),
  );
  await rm(trashed, {
    recursive: true,
    force: true,
  });
  await store.removeTrash(id);
  recordAudit({
    action: "trash.purged",
    actor: auditUser(access.user),
    target: { type: "path", id: item.path },
    details: { trashId: item.id },
  });
}

export async function moveItem(
  store: DriveStore,
  access: Access,
  sourcePath: string,
  targetPath: string,
  options: TransferOptions = {},
) {
  const source = await safePath(sourcePath);
  const target = await safePath(targetPath);
  // A replaced folder goes to trash under this id.
  const trashId = randomUUID();
  return mutateFiles(
    [source.relative, target.relative],
    { userId: access.user.id, lockTokens: options.lockTokens },
    async () =>
      moveUnlocked(
        store,
        await getAccess(store, access.user.id),
        source.relative,
        target.relative,
        options.existing ?? "refuse",
        trashId,
      ),
    { trash: [trashId] },
  );
}

export async function trashItem(
  store: DriveStore,
  access: Access,
  requested: string,
  lockTokens?: MutationCredentials["lockTokens"],
) {
  const target = await safePath(requested);
  const id = randomUUID();
  return mutateFiles(
    [target.relative],
    { userId: access.user.id, lockTokens },
    async () =>
      trashUnlocked(
        store,
        await getAccess(store, access.user.id),
        target.relative,
        id,
      ),
    { trash: [id] },
  );
}

export async function restoreItem(
  store: DriveStore,
  access: Access,
  id: string,
) {
  // The trash row's path never changes, so it can be read before the lock.
  const item = await getOwnedTrash(store, access, id);
  return mutateFiles(
    [item.path],
    { userId: access.user.id },
    async () =>
      restoreUnlocked(store, await getAccess(store, access.user.id), id),
    { trash: [id] },
  );
}

export async function purgeItem(store: DriveStore, access: Access, id: string) {
  return mutateFiles(
    [],
    { userId: access.user.id },
    async () =>
      purgeUnlocked(store, await getAccess(store, access.user.id), id),
    { trash: [id] },
  );
}
