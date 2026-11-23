import { lstat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Access } from "@nimbus/api/access";
import { auditUser, recordAudit } from "@nimbus/api/audit";
import { DriveRoot } from "@nimbus/api/drive-root";
import { Homes } from "@nimbus/api/homes";
import { isFsError, PathError, resolveSafePath } from "@nimbus/api/safe-path";
import { libraries, libraryFolders } from "../db/library-schema";
import type { LibraryContext } from "./library-context";
import { PairedDevices } from "./paired-devices";

/** A library as its owner's Settings shows it. */
export type Library = {
  id: string;
  title: string;
  folders: string[];
  /** The live devices paired to it. */
  devices: { id: string; name: string }[];
  createdAt: number;
};

export type LibraryRefusal =
  | { kind: "invalid"; message: string }
  | { kind: "forbidden"; message: string }
  | { kind: "not_found"; message: string }
  /** Adding folders reaches devices already paired: the owner must confirm, naming them. */
  | { kind: "confirm_devices"; message: string; devices: string[] };

export type LibraryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: LibraryRefusal };

export type LibraryInput = { title: string; folders: readonly string[] };

const maxFolders = 20;
const maxTitle = 120;
const refuse = <T>(error: LibraryRefusal): LibraryResult<T> => ({
  ok: false,
  error,
});
const nameOf = (path: string) => DriveRoot.nameOf(path);

function parseTitle(title: string): LibraryResult<string> {
  const trimmed = title.normalize("NFC").trim();
  if (!trimmed || [...trimmed].length > maxTitle || /\p{Cc}/u.test(trimmed))
    return refuse({
      kind: "invalid",
      message: `Give the library a name of 1 to ${maxTitle} characters. Nothing was saved.`,
    });
  return { ok: true, value: trimmed };
}

/**
 * Why `path` cannot be a folder of `access.user`'s library, or null when it can: the drive root,
 * a home-folder container or a folder above one, another account's home, a folder the account
 * may not share, and anything that is not an existing folder are refused.
 */
async function folderRefusal(
  ctx: Pick<LibraryContext, "drive">,
  access: Access,
  requested: string,
): Promise<{ path: string } | { refusal: LibraryRefusal }> {
  let path: string;
  try {
    path = (await resolveSafePath(requested)).relative;
  } catch (error) {
    if (error instanceof PathError)
      return {
        refusal: {
          kind: error.code === "FORBIDDEN" ? "forbidden" : "invalid",
          message: `${error.message} Nothing was saved.`,
        },
      };
    throw error;
  }
  const refused = (message: string) => ({
    refusal: { kind: "forbidden" as const, message },
  });
  if (path === "")
    return refused(
      `${DriveRoot.label}, the top of the drive, cannot be a library folder. Choose the folders whose files the library should offer. Nothing was saved.`,
    );
  if ((await Homes.exposedBy(ctx.drive, path)).containers.length)
    return refused(
      `"${nameOf(path)}" holds every account's home folder, so it cannot be a library folder. Choose a folder inside it. Nothing was saved.`,
    );
  const homes = await ctx.drive.listHomes();
  if (
    homes.some(
      (home) => home.userId !== access.user.id && Homes.covers(home.path, path),
    )
  )
    return refused(
      `"${nameOf(path)}" is in another account's home folder, so it cannot be in your library. Nothing was saved.`,
    );
  // The rule for public links: only someone who may share a folder may hand it to a device.
  if (!access.can(path, "admin"))
    return refused(
      `You can add only folders you can share, and you cannot share "${nameOf(path)}". Ask its owner for sharing access. Nothing was saved.`,
    );
  try {
    const stats = await lstat((await resolveSafePath(path)).absolute);
    if (!stats.isDirectory())
      return {
        refusal: {
          kind: "invalid",
          message: `"${nameOf(path)}" is not a folder. Choose a folder. Nothing was saved.`,
        },
      };
  } catch (error) {
    if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR"))
      return {
        refusal: {
          kind: "not_found",
          message: `"${nameOf(path)}" no longer exists. Choose another folder. Nothing was saved.`,
        },
      };
    throw error;
  }
  return { path };
}

async function parseFolders(
  ctx: Pick<LibraryContext, "drive">,
  access: Access,
  requested: readonly string[],
): Promise<LibraryResult<string[]>> {
  if (requested.length === 0 || requested.length > maxFolders)
    return refuse({
      kind: "invalid",
      message: `Choose 1 to ${maxFolders} folders for the library. Nothing was saved.`,
    });
  const folders: string[] = [];
  for (const folder of requested) {
    const checked = await folderRefusal(ctx, access, folder);
    if ("refusal" in checked) return refuse(checked.refusal);
    if (!folders.includes(checked.path)) folders.push(checked.path);
  }
  return { ok: true, value: folders };
}

const refusedWhileImpersonating = refuse<never>({
  kind: "forbidden",
  message:
    "You are signed in as this person by an administrator, so you cannot change their libraries. Stop impersonating to return to your own account. Nothing was changed.",
});

const notFound = refuse<never>({
  kind: "not_found",
  message:
    "This library was deleted or belongs to someone else. Reload the page to see your libraries.",
});

const libraryTarget = (id: string, title: string) => ({
  type: "library" as const,
  id,
  label: title,
});

/** The live devices of each of `libraryIds`, by library. */
function liveDevices(
  ctx: Pick<LibraryContext, "db" | "now">,
  ownerId: string,
  libraryIds: string[],
) {
  return PairedDevices.list(ctx, ownerId)
    .filter((device) => libraryIds.includes(device.library.id))
    .reverse()
    .map((device) => ({
      id: device.id,
      name: device.name,
      libraryId: device.library.id,
    }));
}

export const Libraries = {
  folderRefusal,

  /** The libraries of `ownerId`, oldest first. */
  list(ctx: Pick<LibraryContext, "db" | "now">, ownerId: string): Library[] {
    const owned = ctx.db
      .select()
      .from(libraries)
      .where(eq(libraries.ownerId, ownerId))
      .orderBy(asc(libraries.createdAt), asc(libraries.id))
      .all();
    const ids = owned.map((library) => library.id);
    const folders = ids.length
      ? ctx.db
          .select()
          .from(libraryFolders)
          .where(inArray(libraryFolders.libraryId, ids))
          .orderBy(asc(libraryFolders.position))
          .all()
      : [];
    const devices = liveDevices(ctx, ownerId, ids);
    return owned.map((library) => ({
      id: library.id,
      title: library.title,
      createdAt: library.createdAt,
      folders: folders
        .filter((folder) => folder.libraryId === library.id)
        .map((folder) => folder.path),
      devices: devices
        .filter((device) => device.libraryId === library.id)
        .map(({ id, name }) => ({ id, name })),
    }));
  },

  /** The folders of library `id`, in its owner's order. */
  folders(ctx: Pick<LibraryContext, "db">, id: string) {
    return ctx.db
      .select({ path: libraryFolders.path })
      .from(libraryFolders)
      .where(eq(libraryFolders.libraryId, id))
      .orderBy(asc(libraryFolders.position))
      .all()
      .map((row) => row.path);
  },

  async create(
    ctx: Pick<LibraryContext, "db" | "drive" | "now">,
    access: Access,
    impersonated: boolean,
    input: LibraryInput,
  ): Promise<LibraryResult<{ id: string }>> {
    if (impersonated) return refusedWhileImpersonating;
    const title = parseTitle(input.title);
    if (!title.ok) return title;
    const folders = await parseFolders(ctx, access, input.folders);
    if (!folders.ok) return folders;
    const id = `lib_${randomBytes(16).toString("base64url")}`;
    const now = ctx.now();
    ctx.db.transaction((tx) => {
      tx.insert(libraries)
        .values({
          id,
          ownerId: access.user.id,
          title: title.value,
          createdAt: now,
          updatedAt: now,
          catalogChangedAt: now,
        })
        .run();
      tx.insert(libraryFolders)
        .values(
          folders.value.map((path, position) => ({
            libraryId: id,
            path,
            position,
            addedAt: now,
          })),
        )
        .run();
    });
    recordAudit({
      action: "library.created",
      actor: auditUser(access.user),
      target: libraryTarget(id, title.value),
      details: { folders: folders.value.join(", ") },
    });
    return { ok: true, value: { id } };
  },

  /**
   * Rename library `id` and replace its folders, in the order given. A folder new to the library
   * reaches its paired devices at once, so `acknowledgedDevices` must include each of their ids;
   * otherwise nothing changes and the refusal names them. A removed folder stops serving at once.
   */
  async update(
    ctx: Pick<LibraryContext, "db" | "drive" | "now">,
    access: Access,
    impersonated: boolean,
    input: LibraryInput & {
      id: string;
      acknowledgedDevices: readonly string[];
    },
  ): Promise<LibraryResult<{ id: string }>> {
    if (impersonated) return refusedWhileImpersonating;
    const [library] = ctx.db
      .select()
      .from(libraries)
      .where(
        and(eq(libraries.id, input.id), eq(libraries.ownerId, access.user.id)),
      )
      .all();
    if (!library) return notFound;
    const title = parseTitle(input.title);
    if (!title.ok) return title;
    const folders = await parseFolders(ctx, access, input.folders);
    if (!folders.ok) return folders;
    const previous = Libraries.folders(ctx, library.id);
    const added = folders.value.filter((path) => !previous.includes(path));
    const removed = previous.filter((path) => !folders.value.includes(path));
    const devices = liveDevices(ctx, access.user.id, [library.id]);
    const acknowledged = new Set(input.acknowledgedDevices);
    if (added.length && devices.some((device) => !acknowledged.has(device.id)))
      return refuse({
        kind: "confirm_devices",
        devices: devices.map((device) => device.name),
        message: `Adding ${added.length === 1 ? "this folder" : "these folders"} shares ${added.length === 1 ? "its" : "their"} files with ${devices.length === 1 ? "a device" : `${devices.length} devices`} already paired to this library: ${devices.map((device) => device.name).join(", ")}. Confirm to save. Nothing was saved.`,
      });
    const now = ctx.now();
    ctx.db.transaction((tx) => {
      tx.update(libraries)
        .set({ title: title.value, updatedAt: now })
        .where(eq(libraries.id, library.id))
        .run();
      // Rewritten in the new order; folders kept keep when they were added and first scanned.
      const kept = new Map(
        tx
          .select()
          .from(libraryFolders)
          .where(eq(libraryFolders.libraryId, library.id))
          .all()
          .map((folder) => [folder.path, folder]),
      );
      tx.delete(libraryFolders)
        .where(eq(libraryFolders.libraryId, library.id))
        .run();
      tx.insert(libraryFolders)
        .values(
          folders.value.map((path, position) => ({
            libraryId: library.id,
            path,
            position,
            addedAt: kept.get(path)?.addedAt ?? now,
            scannedAt: kept.get(path)?.scannedAt ?? null,
          })),
        )
        .run();
    });
    recordAudit({
      action: "library.updated",
      actor: auditUser(access.user),
      target: libraryTarget(library.id, title.value),
      details: {
        ...(library.title !== title.value && { previousTitle: library.title }),
        foldersAdded: added.join(", "),
        foldersRemoved: removed.join(", "),
        pairedDevices: devices.length,
      },
    });
    return { ok: true, value: { id: library.id } };
  },

  /** Delete library `id`, disconnecting its devices. Its files stay where they are. */
  remove(
    ctx: Pick<LibraryContext, "db" | "now">,
    access: Access,
    impersonated: boolean,
    id: string,
  ): LibraryResult<{ devicesDisconnected: number }> {
    if (impersonated) return refusedWhileImpersonating;
    const [library] = ctx.db
      .select()
      .from(libraries)
      .where(and(eq(libraries.id, id), eq(libraries.ownerId, access.user.id)))
      .all();
    if (!library) return notFound;
    const devicesDisconnected = PairedDevices.revokeLibrary(
      ctx,
      library.id,
      access.user,
    );
    ctx.db.delete(libraries).where(eq(libraries.id, library.id)).run();
    recordAudit({
      action: "library.deleted",
      actor: auditUser(access.user),
      target: libraryTarget(library.id, library.title),
      details: { devicesDisconnected },
    });
    return { ok: true, value: { devicesDisconnected } };
  },
} as const;
