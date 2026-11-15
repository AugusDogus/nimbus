import { TRPCError } from "@trpc/server";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getAccess, type Access } from "./access";
import {
  forgetFileLocks,
  mutateFiles,
  type MutationCredentials,
} from "./file-mutations";
import { getDataRoot } from "./data-root";
import type { DriveStore, TrashItem } from "./drive-store";
import { publishFileEvent } from "./file-events";
import {
  isFsError,
  isWithinPath,
  PathError,
  resolveSafePath,
} from "./safe-path";

export async function safePath(requested: string) {
  try {
    return await resolveSafePath(requested);
  } catch (error) {
    if (error instanceof PathError)
      throw new TRPCError({ code: error.code, message: error.message });
    throw error;
  }
}

export async function requireExisting(requested: string) {
  const target = await safePath(requested);
  try {
    return { ...target, stats: await lstat(target.absolute) };
  } catch (error) {
    if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR"))
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "This file or folder no longer exists. Refresh the drive.",
      });
    throw error;
  }
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

async function moveUnlocked(
  store: DriveStore,
  access: Access,
  sourcePath: string,
  targetPath: string,
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
  if (isWithinPath(source.relative, target.relative))
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Choose a different destination outside this folder.",
    });
  await requireUnused(target.absolute);
  await rename(source.absolute, target.absolute);
  try {
    await store.movePath(source.relative, target.relative);
  } catch (error) {
    await rename(target.absolute, source.absolute);
    throw error;
  }
  forgetFileLocks(source.relative);
  publishFileEvent({ path: source.absolute, event: "delete", ts: Date.now() });
  publishFileEvent({ path: target.absolute, event: "rename", ts: Date.now() });
  return { name: path.basename(target.absolute), path: target.relative };
}

async function trashUnlocked(
  store: DriveStore,
  access: Access,
  requested: string,
) {
  const target = await safePath(requested);
  requireMutable(target.relative);
  access.require(target.relative, "write");
  await requireExisting(target.relative);
  const id = randomUUID();
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
  await store.addTrash(item);
  try {
    await rename(target.absolute, destination);
  } catch (error) {
    await store.restoreTrash(id);
    throw error;
  }
  forgetFileLocks(target.relative);
  publishFileEvent({ path: target.absolute, event: "delete", ts: Date.now() });
  return { path: target.relative };
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
  access.require(target.relative, "write");
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
  const source = path.join(getDataRoot(), ".nimbus", "trash", item.id);
  await rename(source, target.absolute);
  try {
    await store.restoreTrash(id);
  } catch (error) {
    await rename(target.absolute, source);
    throw error;
  }
  publishFileEvent({ path: target.absolute, event: "rename", ts: Date.now() });
  return { path: target.relative };
}

async function purgeUnlocked(store: DriveStore, access: Access, id: string) {
  const item = await getOwnedTrash(store, access, id);
  await rm(path.join(getDataRoot(), ".nimbus", "trash", item.id), {
    recursive: true,
    force: true,
  });
  await store.removeTrash(id);
}

export async function moveItem(
  store: DriveStore,
  access: Access,
  sourcePath: string,
  targetPath: string,
  lockTokens?: MutationCredentials["lockTokens"],
) {
  const source = await safePath(sourcePath);
  const target = await safePath(targetPath);
  return mutateFiles(
    [source.relative, target.relative],
    { userId: access.user.id, lockTokens },
    async () =>
      moveUnlocked(
        store,
        await getAccess(store, access.user.id),
        source.relative,
        target.relative,
      ),
  );
}

export async function trashItem(
  store: DriveStore,
  access: Access,
  requested: string,
  lockTokens?: MutationCredentials["lockTokens"],
) {
  const target = await safePath(requested);
  return mutateFiles(
    [target.relative],
    { userId: access.user.id, lockTokens },
    async () =>
      trashUnlocked(
        store,
        await getAccess(store, access.user.id),
        target.relative,
      ),
  );
}

export async function restoreItem(
  store: DriveStore,
  access: Access,
  id: string,
) {
  const item = await getOwnedTrash(store, access, id);
  return mutateFiles([item.path], { userId: access.user.id }, async () =>
    restoreUnlocked(store, await getAccess(store, access.user.id), id),
  );
}

export async function purgeItem(store: DriveStore, access: Access, id: string) {
  return mutateFiles([], { userId: access.user.id }, async () =>
    purgeUnlocked(store, await getAccess(store, access.user.id), id),
  );
}
