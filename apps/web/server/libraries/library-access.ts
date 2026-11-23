import { and, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getAccess, type Access } from "@nimbus/api/access";
import type { DriveStore } from "@nimbus/api/drive-store";
import { Homes } from "@nimbus/api/homes";
import { DriveFile, type OpenedDriveFile } from "@nimbus/api/drive-file";
import {
  isApiError,
  isFsError,
  isWithinPath,
  lexicalSafePath,
  PathError,
  resolveSafePath,
} from "@nimbus/api/safe-path";
import { libraries, libraryItems } from "../db/library-schema";
import { Libraries } from "./libraries";
import type { LibraryApiError } from "./library-api-error";
import type { LibraryContext } from "./library-context";
import type { PairedDevice } from "./paired-devices";

/**
 * The one way a paired device reaches files. A device's token becomes a scope that reads only
 * inside its library's folders, only what the library's owner may still read, and nothing else:
 * it never takes on the owner's administrator rights, and it refuses every permission but read.
 * Every library API endpoint goes through it; none accepts a path or a library id from a client.
 *
 * A file is reachable only while the token is live (checked by `PairedDevices.authenticate`),
 * the owner's account is active, the owner may read the file, its path lies in one of the
 * library's folders the owner may still share, it is not hidden, it belongs to that library,
 * and it opens as a regular file without following symbolic links anywhere on its path.
 */
export type LibraryScope = {
  device: PairedDevice;
  library: {
    id: string;
    title: string;
    updatedAt: number;
    catalogChangedAt: number;
  };
  /** The library's folders that serve the device, in its owner's order: the ones the owner may still share. */
  folders: string[];
  /** Reads inside `folders` with the owner's current read permission; nothing more. */
  access: Access;
};

export type LibraryItem = {
  id: string;
  libraryId: string;
  path: string;
  addedAt: number;
  version: string;
  sizeBytes: number;
};

/** What a library's catalog covers: the folders that serve. */
export type CatalogTarget = { folders: string[] };

export type ScopeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: LibraryApiError };

const itemIdPattern = /^itm_[A-Za-z0-9_-]{10,64}$/;

const revoked: LibraryApiError = {
  code: "token_revoked",
  message:
    "This device's library or account is no longer available. Pair the device again.",
};

const notFound: LibraryApiError = {
  code: "item_not_found",
  message:
    "This item is not in the library any more. Reload the library to see what is there.",
};

/** A read-only access confined to `folders`, built field by field from the owner's. */
function confined(owner: Access, folders: readonly string[]): Access {
  const inside = (path: string) =>
    folders.some((folder) => isWithinPath(folder, path));
  return {
    user: owner.user,
    grants: [],
    isAdmin: false,
    requireAdmin() {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "A paired device cannot manage users and groups.",
      });
    },
    can: (requested, permission) =>
      permission === "read" &&
      inside(requested) &&
      owner.can(requested, "read"),
    canBrowse: (requested) => inside(requested) && owner.can(requested, "read"),
    require(requested, permission) {
      if (!this.can(requested, permission))
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "This device's library does not include that item.",
        });
    },
  };
}

/** `path` normalized once, or null when it is not a valid drive path or changes on normalizing. */
function canonical(path: string) {
  try {
    const relative = lexicalSafePath(path).relative;
    return relative === path ? relative : null;
  } catch (error) {
    if (error instanceof PathError) return null;
    throw error;
  }
}

/** Open the regular file at `path`, a checked drive path, or null when it is not one. */
async function openRegular(path: string) {
  let opened: OpenedDriveFile;
  try {
    opened = await DriveFile.openForReading(
      (await resolveSafePath(path)).absolute,
    );
  } catch (error) {
    // A file the server may not open answers as one that is not there, so a device cannot
    // tell the two apart.
    if (
      error instanceof PathError ||
      isApiError(error, "NOT_FOUND") ||
      isApiError(error, "FORBIDDEN") ||
      isFsError(error, "EACCES") ||
      isFsError(error, "EPERM")
    )
      return null;
    throw error;
  }
  if (opened.stats.isFile()) return opened;
  await opened.handle.close();
  return null;
}

/**
 * The folders of `configured` that serve: as for public links, only while their owner may still
 * share them, and only while none holds a home-folder container or another account's home and
 * none lies in another account's home. Checked on every use, as configuration can change after
 * a library is made, such as the folder for homes.
 */
async function serving(
  store: DriveStore,
  owner: Access,
  configured: readonly string[],
) {
  const containers = await Homes.containers(store);
  const others = (await store.listHomes()).filter(
    (home) => home.userId !== owner.user.id,
  );
  return configured.filter(
    (folder) =>
      owner.can(folder, "admin") &&
      !containers.some((container) => Homes.covers(folder, container)) &&
      !others.some(
        (home) =>
          Homes.covers(folder, home.path) || Homes.covers(home.path, folder),
      ),
  );
}

export const LibraryAccess = {
  confined,

  /**
   * When library `libraryId`'s title or folders last changed, read synchronously, or null when
   * it is gone: an answer worked out for one version must not go out under another.
   */
  libraryVersion(ctx: Pick<LibraryContext, "db">, libraryId: string) {
    return (
      ctx.db
        .select({ updatedAt: libraries.updatedAt })
        .from(libraries)
        .where(eq(libraries.id, libraryId))
        .get()?.updatedAt ?? null
    );
  },

  /** The catalog `scope` sees: everything a device may observe derives from it alone. */
  /** Whether drive path `path` is written the one way the listing accepts. */
  canonical: (path: string) => canonical(path) !== null,

  catalogTarget: (scope: LibraryScope): CatalogTarget => ({
    folders: scope.folders,
  }),

  /** The catalog of library `libraryId` as its devices would see it now, for background passes. */
  async targetOf(
    ctx: Pick<LibraryContext, "db" | "drive">,
    libraryId: string,
  ): Promise<CatalogTarget> {
    const [library] = ctx.db
      .select({ ownerId: libraries.ownerId })
      .from(libraries)
      .where(eq(libraries.id, libraryId))
      .all();
    const configured = Libraries.folders(ctx, libraryId);
    if (!library) return { folders: [] };
    try {
      const owner = await getAccess(ctx.drive, library.ownerId);
      return { folders: await serving(ctx.drive, owner, configured) };
    } catch (error) {
      if (isApiError(error, "UNAUTHORIZED")) return { folders: [] };
      throw error;
    }
  },

  /** The scope of `device`'s library as of now, or why the device may not use it. */
  async forDevice(
    ctx: Pick<LibraryContext, "db" | "drive">,
    device: PairedDevice,
  ): Promise<ScopeResult<LibraryScope>> {
    const [library] = ctx.db
      .select({
        id: libraries.id,
        title: libraries.title,
        updatedAt: libraries.updatedAt,
        catalogChangedAt: libraries.catalogChangedAt,
      })
      .from(libraries)
      .where(
        and(
          eq(libraries.id, device.libraryId),
          eq(libraries.ownerId, device.ownerId),
        ),
      )
      .all();
    if (!library) return { ok: false, error: revoked };
    let owner: Access;
    try {
      owner = await getAccess(ctx.drive, device.ownerId);
    } catch (error) {
      // A disabled or removed account.
      if (isApiError(error, "UNAUTHORIZED"))
        return { ok: false, error: revoked };
      throw error;
    }
    const configured = Libraries.folders(ctx, library.id);
    const folders = await serving(ctx.drive, owner, configured);
    return {
      ok: true,
      value: {
        device,
        library,
        folders,
        access: confined(owner, folders),
      },
    };
  },

  /**
   * Whether `path`, a stored drive path, is a library item readable through `scope`: inside a
   * serving folder, readable by the owner and not hidden below its folder.
   */
  reaches(scope: LibraryScope, path: string) {
    const relative = canonical(path);
    if (relative === null) return false;
    const folder = scope.folders.find((candidate) =>
      isWithinPath(candidate, relative),
    );
    if (folder === undefined || folder === relative) return false;
    return (
      !relative
        .slice(folder.length + 1)
        .split("/")
        .some((segment) => segment.startsWith(".")) &&
      scope.access.can(relative, "read")
    );
  },

  /** The item `itemId` of the scope's library, when the scope reaches it. */
  resolve(
    ctx: Pick<LibraryContext, "db">,
    scope: LibraryScope,
    itemId: string,
  ): ScopeResult<LibraryItem> {
    if (!itemIdPattern.test(itemId)) return { ok: false, error: notFound };
    const [item] = ctx.db
      .select()
      .from(libraryItems)
      .where(
        and(
          eq(libraryItems.id, itemId),
          eq(libraryItems.libraryId, scope.library.id),
          // A tombstone of a file that went missing answers as any unknown id does.
          isNull(libraryItems.missingSince),
        ),
      )
      .all();
    if (!item || !LibraryAccess.reaches(scope, item.path))
      return { ok: false, error: notFound };
    return { ok: true, value: item };
  },

  /**
   * Open item `itemId` for reading through `scope`: resolved as above, then opened without
   * following symbolic links anywhere on its path and checked to be a regular file. The caller
   * closes the handle.
   */
  async open(
    ctx: Pick<LibraryContext, "db">,
    scope: LibraryScope,
    itemId: string,
  ): Promise<ScopeResult<{ item: LibraryItem; opened: OpenedDriveFile }>> {
    const resolved = LibraryAccess.resolve(ctx, scope, itemId);
    if (!resolved.ok) return resolved;
    const opened = await openRegular(resolved.value.path);
    return opened
      ? { ok: true, value: { item: resolved.value, opened } }
      : { ok: false, error: notFound };
  },
} as const;
