import { createHash } from "node:crypto";
import path from "node:path";
import { eq } from "drizzle-orm";
import { isWithinPath } from "@nimbus/api/safe-path";
import { libraries, type LibraryItemKind } from "../db/library-schema";
import { ItemKind } from "./item-kind";
import type { LibraryApiError } from "./library-api-error";
import {
  LibraryAccess,
  type LibraryItem,
  type LibraryScope,
} from "./library-access";
import { LibraryCatalog, MAX_LIBRARY_ITEMS } from "./library-catalog";
import type { LibraryContext } from "./library-context";

/**
 * GET /library: the library as one flat list, newest first, in the shape of
 * docs/library-api/openapi.yaml. Posters are null until a later slice fills them.
 */
export type ListedItem = {
  id: string;
  /** The file's real name, extension included. */
  name: string;
  kind: LibraryItemKind;
  contentType: string;
  /** Which of the device's library folders holds the item: 0 for the first, in the owner's order. */
  folder: number;
  /** The item's path below that folder, real names joined with `/`, such as `Guides/Loaf.md`. */
  path: string;
  addedAt: string;
  sizeBytes: number;
  version: string;
  poster: null;
};

export type LibraryBody = {
  library: { id: string; title: string };
  items: ListedItem[];
  generatedAt: string;
};

/**
 * Where `itemPath`, a drive path the scope reaches, lies: the outermost of the device's library
 * folders that holds it, by its index in `folders`, and the path below that folder. Nothing at
 * or above a library folder is shown. Null when no folder holds it.
 */
function placeOf(
  folders: readonly string[],
  itemPath: string,
): { folder: number; path: string } | null {
  let outermost: { folder: number; root: string } | null = null;
  for (const [index, root] of folders.entries())
    if (
      root !== itemPath &&
      isWithinPath(root, itemPath) &&
      (outermost === null || root.length < outermost.root.length)
    )
      outermost = { folder: index, root };
  return outermost === null
    ? null
    : {
        folder: outermost.folder,
        path: itemPath.slice(outermost.root.length + 1),
      };
}

function listed(
  folders: readonly string[],
  item: LibraryItem,
): ListedItem | null {
  const place = placeOf(folders, item.path);
  if (place === null) return null;
  const name = path.posix.basename(item.path);
  const { kind, contentType } = ItemKind.of(name);
  return {
    id: item.id,
    name,
    kind,
    contentType,
    folder: place.folder,
    path: place.path,
    addedAt: new Date(item.addedAt).toISOString(),
    sizeBytes: item.sizeBytes,
    version: item.version,
    poster: null,
  };
}

const newestFirst = (a: LibraryItem, b: LibraryItem) =>
  a.addedAt !== b.addedAt
    ? b.addedAt - a.addedAt
    : a.id < b.id
      ? -1
      : a.id > b.id
        ? 1
        : 0;

export type LibraryListingResult =
  | { ok: true; body: LibraryBody; etag: string }
  | { ok: false; error: LibraryApiError };

export const LibraryListing = {
  /** The scope's library, only items of `kinds` when given. */
  async library(
    ctx: Pick<LibraryContext, "db" | "now">,
    scope: LibraryScope,
    kinds: readonly LibraryItemKind[] | null,
  ): Promise<LibraryListingResult> {
    if (scope.folders.length === 0)
      return {
        ok: false,
        error: {
          code: "library_unavailable",
          message:
            "The owner of this library can no longer share any of its folders, so it offers nothing. Ask them to check the library in Nimbus Settings, Libraries.",
        },
      };
    // Only what the device may see now: items, the size limit and change times alike.
    const catalog = await LibraryCatalog.items(
      ctx,
      scope.library.id,
      LibraryAccess.catalogTarget(scope),
    );
    if (catalog.kind === "too_large")
      return {
        ok: false,
        error: {
          code: "library_too_large",
          message: `This library has more than ${MAX_LIBRARY_ITEMS.toLocaleString("en")} files. Ask its owner to choose fewer folders in Nimbus Settings, Libraries.`,
        },
      };
    const items = catalog.items
      .filter((item) => LibraryAccess.reaches(scope, item.path))
      .sort(newestFirst)
      .flatMap((item) => {
        const entry = listed(scope.folders, item);
        return entry === null ? [] : [entry];
      })
      .filter((item) => kinds === null || kinds.includes(item.kind));
    // Read after the catalog step, which may just have recorded a change.
    const changed =
      ctx.db
        .select({
          updatedAt: libraries.updatedAt,
          catalogChangedAt: libraries.catalogChangedAt,
        })
        .from(libraries)
        .where(eq(libraries.id, scope.library.id))
        .get() ?? scope.library;
    const body: LibraryBody = {
      library: { id: scope.library.id, title: scope.library.title },
      items,
      generatedAt: new Date(
        Math.max(changed.updatedAt, changed.catalogChangedAt),
      ).toISOString(),
    };
    const etag = `"lib-${createHash("sha256").update(JSON.stringify(body)).digest("base64url").slice(0, 32)}"`;
    return { ok: true, body, etag };
  },
} as const;
