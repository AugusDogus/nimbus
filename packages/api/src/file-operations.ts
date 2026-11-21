import { TRPCError } from "@trpc/server";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, rm } from "node:fs/promises";
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
  lexicalSafePath,
  PathError,
  resolveSafePath,
} from "./safe-path";
import { FilesystemFailure } from "./filesystem-failure";
import { PendingChanges } from "./pending-changes";
import { Staging } from "./staging";
import {
  ItemIdentity,
  TransferReceipt,
  type ReceiptRefusal,
} from "./transfer-receipt";
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

/** `lexicalSafePath` with tRPC errors: for permission checks before `safePath` reads the disk. */
export function lexicalPath(requested: string) {
  try {
    return lexicalSafePath(requested);
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

/** Something already has the name an item was to get. Callers that offer a choice catch it. */
export class NameTakenError extends TRPCError {
  constructor() {
    super({
      code: "CONFLICT",
      message: "An item with that name already exists. Choose another name.",
    });
    this.name = "NameTakenError";
  }
}

export async function requireUnused(absolute: string) {
  try {
    await lstat(absolute);
  } catch (error) {
    if (isFsError(error, "ENOENT")) return;
    throw error;
  }
  throw new NameTakenError();
}

/**
 * A rename across filesystems fails with EXDEV: the destination is in a folder mounted inside
 * the drive (another disk or share, a bind mount, a btrfs subvolume). Moving there would mean
 * copying and then deleting, which is not one step: a crash could leave both or half a copy,
 * crash recovery could no longer recognise the item, and its links, grants and history would
 * have to follow content that is not the same item. So Nimbus refuses, says why, and leaves
 * the choice to copy to the person.
 */
const crossDevice = (source: string, target: string) => {
  const parent = path.posix.dirname(target);
  return new TRPCError({
    code: "BAD_REQUEST",
    message: `“${path.posix.basename(source)}” is on a different disk or share from ${parent === "." ? "the top folder" : `“${path.posix.basename(parent)}”`}, so Nimbus cannot move it there in one step. Nothing was changed. Copy it there instead, then move the original to trash once you have checked the copy.`,
  });
};

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

/**
 * A step after an item's change on disk failed: the change stands, but what follows it, such as
 * its records, its properties or the facts its Undo needs, may not have happened. Callers report
 * the item's outcome as unknown, never as unchanged. `cause` keeps the original error, with its
 * host paths, for the server log only.
 */
export class PartwayError extends Error {
  constructor(cause: unknown) {
    super("A step after a change on disk failed.", { cause });
    this.name = "PartwayError";
  }
}

/** Run what follows a change on disk; its failure is a `PartwayError`. */
async function afterCommit<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    throw new PartwayError(error);
  }
}

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
  await Homes.requireNotReserved(store, target.relative);
  access.require(source.relative, "write");
  access.require(target.relative, "write");
  // A moved item keeps its own links, direct grants, and bookmarks, but stops inheriting from its
  // source's ancestors and inherits from its destination's instead. That can expose a whole
  // subtree to new people, so moving a folder requires control of its sharing.
  const existing = await requireExisting(source.relative);
  if (existing.stats.isDirectory()) access.require(source.relative, "admin");
  requireSeparate(source.relative, target.relative);
  await Homes.requireNotHome(store, source.relative);
  // Two names of one file (hard links): renaming one over the other removes nothing, so the
  // source would stay while its records were discarded as if it had moved.
  const current = await statOrNull(target.absolute);
  if (
    current !== null &&
    current.dev === existing.stats.dev &&
    current.ino === existing.stats.ino
  )
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "These two names are hard links to the same file on the server, so moving one onto the other would change nothing. Nothing was changed. Delete the name you no longer need instead.",
    });
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
        identity: await PendingChanges.identityAt(existing.absolute),
        kind: "move",
        from: source.relative,
        to: target.relative,
      });
      try {
        await DriveFile.renameChecked(source.absolute, target.absolute);
      } catch (error) {
        await store.removePendingChange(pending);
        if (isFsError(error, "EXDEV"))
          throw crossDevice(source.relative, target.relative);
        throw error;
      }
      try {
        await store.movePath(source.relative, target.relative, pending);
      } catch (error) {
        // Checked like the move itself, so a folder swapped meanwhile cannot redirect it.
        // When it cannot go back, it stays moved without its records: partway.
        await afterCommit(() =>
          DriveFile.renameChecked(target.absolute, source.absolute),
        );
        await store.removePendingChange(pending);
        throw error;
      }
    }
  } catch (error) {
    await undoReplacement(store, access, replacement);
    throw error;
  }
  return afterCommit(async () => {
    forgetFileLocks(source.relative);
    publishFileEvent({
      path: source.absolute,
      event: "delete",
      ts: Date.now(),
    });
    publishFileEvent({
      path: target.absolute,
      event: replacement.kind === "content" ? "change" : "rename",
      ts: Date.now(),
    });
    return {
      name: path.basename(target.absolute),
      path: target.relative,
      replaced: replacement.kind !== "vacant",
      // Read inside the mutation scope, before anything else can change the item.
      identity: await ItemIdentity.identityAt(target.absolute),
    };
  });
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
  const requested = lexicalPath(sourcePath);
  const destination = lexicalPath(targetPath);
  requireMutable(destination.relative);
  // Before either is looked up, so neither reveals whether it exists.
  access.require(requested.relative, "read");
  access.require(destination.relative, "write");
  const target = await safePath(targetPath);
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
            await DriveFile.renameChecked(staging, target.absolute);
          }
        } catch (error) {
          await undoReplacement(store, current, replacement);
          throw error;
        }
        return afterCommit(async () => {
          // Dead properties describe the content, so the copy keeps them (RFC 4918, 9.8.2).
          await store.copyDavProperties(source.relative, target.relative);
          publishFileEvent({
            path: target.absolute,
            event: replacement.kind === "content" ? "change" : "rename",
            ts: Date.now(),
          });
          return {
            path: target.relative,
            replaced: replacement.kind !== "vacant",
            identity: await ItemIdentity.identityAt(target.absolute),
          };
        });
      },
      { trash: [trashId] },
    );
  } finally {
    // Whatever the copy did stands; leftover staging is cleaned by maintenance.
    await rm(staging, { recursive: true, force: true }).catch((error) =>
      console.error("Could not remove a copy's staging folder.", error),
    );
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
  const existing = await requireExisting(target.relative);
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
  await store.addPendingChange({
    id: pending,
    identity: await PendingChanges.identityAt(existing.absolute),
    kind: "trash",
    trashId: id,
  });
  await store.addTrash(item);
  try {
    await DriveFile.renameChecked(target.absolute, destination);
  } catch (error) {
    await store.restoreTrash(id);
    await store.removePendingChange(pending);
    throw error;
  }
  return afterCommit(async () => {
    await store.removePendingChange(pending);
    forgetFileLocks(target.relative);
    publishFileEvent({
      path: target.absolute,
      event: "delete",
      ts: Date.now(),
    });
    recordAudit({
      action: "trash.moved",
      actor: auditUser(access.user),
      target: { type: "path", id: target.relative },
      details: { trashId: id },
    });
    return { path: target.relative, trashId: id };
  });
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
  if (await PendingChanges.blocksRestore(store, id))
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "Nimbus was interrupted while changing this item, and other content now stands in its place in trash, so restoring it could give that content this item's sharing. It was not restored. Delete it for good, or ask a server administrator to check the server's trash folder.",
    });
  const target = await safePath(item.path);
  await Homes.requireNotReserved(store, target.relative);
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
  await store.addPendingChange({
    id: pending,
    identity: await PendingChanges.identityAt(source),
    kind: "restore",
    trashId: id,
  });
  try {
    await DriveFile.renameChecked(source, target.absolute);
  } catch (error) {
    await store.removePendingChange(pending);
    throw error;
  }
  try {
    await store.restoreTrash(id);
  } catch (error) {
    await DriveFile.renameChecked(target.absolute, source);
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
  await PendingChanges.forgetTrashItem(store, id);
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
  // Before the lock check, so a WebDAV lock on a path the caller cannot change does not
  // reveal that it exists. Checked again inside, with current access.
  access.require(source.relative, "write");
  access.require(target.relative, "write");
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

/** Why undoing a transfer changed nothing for one item. */
export type UndoRefusal =
  | ReceiptRefusal
  /** Something other than the transferred item is where it ended up. */
  | "changed"
  /** Nothing is where it ended up. */
  | "missing"
  /** A move cannot go back: something else now has the item's original name. */
  | "original-taken"
  /** The account may no longer change the item or the folder it came from. */
  | "forbidden"
  /** Undone already: a receipt works once. */
  | "used"
  /** Nimbus is remembering as many undone receipts as it can; see `USED_RECEIPT_LIMIT`. */
  | "busy"
  /** Anything else the move or trash refused, with its own reason. */
  | "refused";

export type UndoOutcome =
  | { kind: "undone"; receipt: TransferReceipt }
  | {
      kind: "kept";
      receipt: TransferReceipt;
      reason: UndoRefusal;
      message: string;
    }
  /** Something unexpected failed partway: the item may or may not be back. */
  | { kind: "unknown"; receipt: TransferReceipt; message: string };

const quoted = (relative: string) => `“${path.posix.basename(relative)}”`;
const folderOf = (relative: string) => {
  const parent = path.posix.dirname(relative);
  return parent === "." ? "the top folder" : quoted(parent);
};

/** What happened to an item whose transfer was not undone, and where it is. */
function keptMessage(
  receipt: TransferReceipt,
  reason: UndoRefusal,
  cause = "",
) {
  const item = quoted(receipt.from);
  const stays =
    receipt.operation === "move"
      ? `${item} stayed in ${folderOf(receipt.to)}`
      : `The copy ${quoted(receipt.to)} was kept`;
  switch (reason) {
    case "forged":
    case "other-account":
      return `This undo was not issued to your account, so nothing was changed.`;
    case "expired":
      return `${stays}: it can only be undone for an hour after it happened. Move or delete it yourself.`;
    case "restarted":
      return `${stays}: Nimbus restarted since, so this change can no longer be undone. ${receipt.operation === "move" ? "Move it back" : "Delete it"} yourself.`;
    case "used":
      return "This change was already undone, so nothing more was changed.";
    case "busy":
      return `${stays}: Nimbus is undoing too many changes at once. Nothing was changed; try again in a few minutes.`;
    case "changed":
      return receipt.operation === "move"
        ? `${item} was changed since and stayed in ${folderOf(receipt.to)}.`
        : `The copy ${quoted(receipt.to)} was changed since, so it was kept.`;
    case "missing":
      return receipt.operation === "move"
        ? `${item} is no longer in ${folderOf(receipt.to)}, so nothing was moved back.`
        : `The copy ${quoted(receipt.to)} is no longer there, so there was nothing to remove.`;
    case "original-taken":
      return `Something else is now called ${item} in ${folderOf(receipt.from)}, so ${item} stayed in ${folderOf(receipt.to)}.`;
    case "forbidden":
    case "refused":
      return `${stays}. ${cause}`;
  }
}

const kept = (
  receipt: TransferReceipt,
  reason: UndoRefusal,
  cause?: string,
): UndoOutcome => ({
  kind: "kept",
  receipt,
  reason,
  message: keptMessage(receipt, reason, cause),
});

/**
 * Undo one move or copy from its receipt, checking everything again as of now: the receipt
 * was issued to this account and is recent, the same item is still where the transfer left it,
 * and the account may still make the reverse change. A move goes back only to its vacant
 * original path; a copy goes to trash, where it stays recoverable. Anything that no longer
 * matches is left alone, with the reason. Never throws: an unexpected failure is reported as
 * an unknown outcome for this item, so the items undone before it keep theirs.
 */
export async function undoTransfer(
  store: DriveStore,
  access: Access,
  receipt: TransferReceipt,
): Promise<UndoOutcome> {
  const verified = TransferReceipt.verify(receipt, access.user.id);
  if (!verified.ok) return kept(receipt, verified.reason);
  try {
    const landed = lexicalPath(receipt.to);
    const original = lexicalPath(receipt.from);
    // Before anything is looked up, as a move or trash checks, so nothing reveals what exists.
    access.require(landed.relative, "write");
    if (receipt.operation === "move")
      access.require(original.relative, "write");
    const trashId = randomUUID();
    return await mutateFiles(
      receipt.operation === "move"
        ? [landed.relative, original.relative]
        : [landed.relative],
      { userId: access.user.id },
      async () => {
        const current = await getAccess(store, access.user.id);
        current.require(landed.relative, "write");
        // Inside the scope, so two undos of one receipt cannot both pass.
        if (TransferReceipt.wasUsed(receipt)) return kept(receipt, "used");
        if (!TransferReceipt.canMarkUsed()) return kept(receipt, "busy");
        const at = await safePath(landed.relative);
        // A folder moved back may have gained or lost entries since; a copy is trashed only
        // exactly as it was made, never with work added to it.
        const match = await ItemIdentity.matchAt(
          at.absolute,
          receipt.identity,
          receipt.operation === "move" ? "entries" : "exact",
        );
        if (match !== "same") return kept(receipt, match);
        if (receipt.operation === "copy") {
          await trashUnlocked(store, current, at.relative, trashId);
          TransferReceipt.markUsed(receipt);
          return { kind: "undone", receipt } satisfies UndoOutcome;
        }
        current.require(original.relative, "write");
        const back = await safePath(original.relative);
        if (await statOrNull(back.absolute))
          return kept(receipt, "original-taken");
        await moveUnlocked(
          store,
          current,
          at.relative,
          back.relative,
          "refuse",
          trashId,
        );
        TransferReceipt.markUsed(receipt);
        return { kind: "undone", receipt } satisfies UndoOutcome;
      },
      { trash: [trashId] },
    );
  } catch (caught) {
    // A filesystem refusal before anything changed on disk, such as the service account
    // lacking permission, is as precise as any other; after a change, only `PartwayError`.
    const error =
      caught instanceof PartwayError
        ? caught
        : (FilesystemFailure.toApiError(caught) ?? caught);
    // Expected refusals say why; anything else may have happened partway, and says only that.
    if (!(error instanceof TRPCError)) {
      console.error(
        `Undoing the ${receipt.operation} of ${receipt.from} to ${receipt.to} failed partway.`,
        error,
      );
      return {
        kind: "unknown",
        receipt,
        message: `Something went wrong partway through undoing ${quoted(receipt.from)}, so Nimbus cannot say how it ended. Check ${folderOf(receipt.from)} and ${folderOf(receipt.to)}.`,
      };
    }
    if (error.code === "FORBIDDEN")
      return kept(receipt, "forbidden", error.message);
    if (error.code === "NOT_FOUND") return kept(receipt, "missing");
    return kept(receipt, "refused", error.message);
  }
}

export async function trashItem(
  store: DriveStore,
  access: Access,
  requested: string,
  lockTokens?: MutationCredentials["lockTokens"],
) {
  const target = await safePath(requested);
  // Before the lock check, so a WebDAV lock on a path the caller cannot change does not
  // reveal that it exists. Checked again inside, with current access.
  access.require(target.relative, "write");
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
