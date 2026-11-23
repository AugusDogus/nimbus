import { createHash } from "node:crypto";
import path from "node:path";
import { eq } from "drizzle-orm";
import { isWithinPath } from "@nimbus/api/safe-path";
import { libraries, type LibraryItemKind } from "../db/library-schema";
import { DisplayTitle } from "./display-title";
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
 * docs/library-api/openapi.yaml. Fields later slices fill (posters, media details, page counts,
 * progress) are null until then.
 */
export type ListedItem = {
  id: string;
  /** The file's real name, extension included. */
  name: string;
  /** A display title derived from the name; see DisplayTitle. */
  title: string;
  kind: LibraryItemKind;
  contentType: string;
  subtitle: null;
  collection: string | null;
  addedAt: string;
  sizeBytes: number;
  version: string;
  poster: null;
  media: null;
  pageCount: null;
  progress: null;
  isNew: true;
};

export type LibraryBody = {
  library: { id: string; title: string };
  items: ListedItem[];
  generatedAt: string;
};

/** The first folder level under the library folder that holds `itemPath`, or null. */
function collectionOf(folders: readonly string[], itemPath: string) {
  const folder = folders
    .filter((candidate) => isWithinPath(candidate, itemPath))
    .sort((a, b) => a.length - b.length)[0];
  if (folder === undefined) return null;
  const [first, ...rest] = itemPath.slice(folder.length + 1).split("/");
  return first !== undefined && rest.length > 0
    ? DisplayTitle.collection(first)
    : null;
}

function listed(folders: readonly string[], item: LibraryItem): ListedItem {
  const name = path.posix.basename(item.path);
  const { kind, contentType } = ItemKind.of(name);
  return {
    id: item.id,
    name,
    title: DisplayTitle.fromFileName(name, kind, item.id),
    kind,
    contentType,
    subtitle: null,
    collection: collectionOf(folders, item.path),
    addedAt: new Date(item.addedAt).toISOString(),
    sizeBytes: item.sizeBytes,
    version: item.version,
    poster: null,
    media: null,
    pageCount: null,
    progress: null,
    isNew: true,
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
  collectionOf,

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
      .map((item) => listed(scope.configured, item))
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
