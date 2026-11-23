import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import type { OpenedDriveFile } from "@nimbus/api/drive-file";
import { isFsError } from "@nimbus/api/safe-path";
import { libraryItems, libraryPosters } from "../db/library-schema";
import { FileVersion } from "../file-version";
import {
  PosterRender,
  type Dimensions,
  type PosterSource,
} from "../poster-render";
import { getConfigRoot } from "../storage-paths";
import { createLimiter } from "../thumbnails";
import {
  LibraryAccess,
  type LibraryItem,
  type LibraryScope,
} from "./library-access";
import { LibraryApiError } from "./library-api-error";
import { LibraryCatalog } from "./library-catalog";
import type { LibraryContext } from "./library-context";

/**
 * GET and HEAD /items/{id}/poster?w=: an item's poster as a JPEG, and the `poster` field the
 * listing gives each item. Every lookup happens after `LibraryAccess` resolved and opened the
 * item for the asking device, so neither the cache nor the records can tell a device about a
 * file outside its library.
 *
 * Posters are cached on disk beside the thumbnails (and evicted with them), named by a hash of
 * the item, its path, the opened file's `FileVersion` and the width: a changed or replaced file
 * has a different name, so an old poster is never served for it. What a render found (the
 * source's size, or that it failed) is recorded per item and version in SQLite, which is all
 * the listing reads.
 */

export const POSTER_WIDTHS = [400, 800, 1920] as const;
export type PosterWidth = (typeof POSTER_WIDTHS)[number];
const DEFAULT_WIDTH: PosterWidth = 800;
const LARGEST: PosterWidth = 1920;

/** Bumped when posters are drawn differently, so cached ones and ETags are replaced. */
const FORMAT = 1;

/** How long a poster whose render ran out of time answers poster_failed before one more try. */
const TIMEOUT_RETRY_MS = 10 * 60 * 1000;

/** Posters one device may have drawn at once, and how many more may wait. */
const DEVICE_CONCURRENCY = 4;
const DEVICE_QUEUE = 64;
const BUSY_RETRY_SECONDS = 2;

export type ListedPoster = {
  /** The poster endpoint's path; the client adds `?w=`. */
  url: string;
  /** The source's size, or null until its first poster has been drawn. */
  width: number | null;
  height: number | null;
};

/** What a render found for one version of an item's file. */
export type PosterRecord =
  | { state: "ready"; version: string; size: Dimensions }
  | { state: "failed"; version: string }
  | { state: "timed_out"; version: string; recordedAt: number };

type Row = typeof libraryPosters.$inferSelect;

function record(row: Row): PosterRecord | null {
  if (row.state === "ready")
    return row.width !== null && row.height !== null
      ? {
          state: "ready",
          version: row.version,
          size: { width: row.width, height: row.height },
        }
      : null;
  if (row.state === "failed") return { state: "failed", version: row.version };
  return {
    state: "timed_out",
    version: row.version,
    recordedAt: row.recordedAt,
  };
}

/** The width of a `w` query: missing is the default, any other number the nearest size. */
function parseWidth(value: string | null): PosterWidth | null {
  if (value === null) return DEFAULT_WIDTH;
  if (!/^\d{1,9}$/.test(value)) return null;
  const wanted = Number(value);
  // Halfway between two sizes rounds up.
  return POSTER_WIDTHS.reduce((best, width) =>
    Math.abs(width - wanted) <= Math.abs(best - wanted) ? width : best,
  );
}

const posterUrl = (itemId: string) =>
  `/api/library/v1/items/${encodeURIComponent(itemId)}/poster`;

/** Whether the file named `name` has a poster this server can draw. */
function drawable(name: string): PosterSource | null {
  const source = PosterRender.sourceOf(name);
  return source !== null && PosterRender.available(source) ? source : null;
}

/** The listing's `poster` for an item, from what was recorded for it. Touches no file. */
function listed(
  item: { id: string; name: string; version: string },
  known: PosterRecord | undefined,
): ListedPoster | null {
  if (drawable(item.name) === null) return null;
  const current = known?.version === item.version ? known : undefined;
  if (current?.state === "failed") return null;
  const size = current?.state === "ready" ? current.size : null;
  return {
    url: posterUrl(item.id),
    width: size?.width ?? null,
    height: size?.height ?? null,
  };
}

const rowsFor = (ctx: Pick<LibraryContext, "db">, libraryId: string) =>
  ctx.db
    .select({ poster: libraryPosters })
    .from(libraryPosters)
    .innerJoin(libraryItems, eq(libraryItems.id, libraryPosters.itemId))
    .where(eq(libraryItems.libraryId, libraryId))
    .all();

function recordOf(ctx: Pick<LibraryContext, "db">, itemId: string) {
  const row = ctx.db
    .select()
    .from(libraryPosters)
    .where(eq(libraryPosters.itemId, itemId))
    .get();
  return row ? record(row) : null;
}

function remember(
  ctx: Pick<LibraryContext, "db" | "now">,
  itemId: string,
  version: string,
  found:
    | { state: "ready"; size: Dimensions }
    | { state: "failed" }
    | { state: "timed_out" },
) {
  const values = {
    version,
    state: found.state,
    width: found.state === "ready" ? found.size.width : null,
    height: found.state === "ready" ? found.size.height : null,
    recordedAt: ctx.now(),
  };
  ctx.db
    .insert(libraryPosters)
    .values({ itemId, ...values })
    .onConflictDoUpdate({ target: libraryPosters.itemId, set: values })
    .run();
}

const cacheDirectory = () => path.join(getConfigRoot(), "cache", "thumbnails");

function cacheName(
  item: LibraryItem,
  file: OpenedDriveFile,
  width: PosterWidth,
) {
  const hash = createHash("sha256")
    .update(
      `poster\0${FORMAT}\0${item.id}\0${item.path}\0${FileVersion.of(file.stats)}\0${width}`,
    )
    .digest("hex");
  return `poster-${hash}.jpg`;
}

async function readCached(name: string) {
  try {
    return new Uint8Array(await readFile(path.join(cacheDirectory(), name)));
  } catch (error) {
    if (isFsError(error, "ENOENT")) return null;
    throw error;
  }
}

/** The cached file's size in bytes, or null when it is not cached. */
async function cachedSize(name: string) {
  try {
    return (await stat(path.join(cacheDirectory(), name))).size;
  } catch (error) {
    if (isFsError(error, "ENOENT")) return null;
    throw error;
  }
}

async function store(name: string, body: Uint8Array) {
  const directory = cacheDirectory();
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, body);
    await rename(temporary, path.join(directory, name));
  } finally {
    await rm(temporary, { force: true });
  }
}

const failed: LibraryApiError = {
  code: "poster_failed",
  message:
    "Nimbus could not draw a poster for this file. The file itself is unchanged; it is tried again once it changes.",
};

const notAvailable: LibraryApiError = {
  code: "poster_not_available",
  message: "This item has no poster. Show its title or kind instead.",
};

const busy: LibraryApiError = {
  code: "rate_limited",
  message: `Nimbus is drawing many posters right now. Wait ${BUSY_RETRY_SECONDS} seconds and ask again.`,
  retryAfterSeconds: BUSY_RETRY_SECONDS,
};

const changed: LibraryApiError = {
  code: "service_unavailable",
  message:
    "This file changed while its poster was drawn. Ask again in a moment.",
  retryAfterSeconds: 1,
};

type Largest =
  | { ok: true; jpeg: Uint8Array<ArrayBuffer> }
  | { ok: false; error: LibraryApiError };

/**
 * Renders under way, by the largest poster's cache name, so requests for the same poster share
 * one. A render runs to the end once started, even if its requests left: its result is kept.
 */
const rendering = new Map<string, Promise<Largest>>();

/** The largest poster of the item: cached, or drawn and recorded now. */
async function largest(
  ctx: Pick<LibraryContext, "db" | "now">,
  item: LibraryItem,
  file: OpenedDriveFile,
  source: PosterSource,
  version: string,
  known: PosterRecord | null,
): Promise<Largest> {
  const name = cacheName(item, file, LARGEST);
  // Trusted only with its record, which the listing's dimensions come from.
  if (known?.state === "ready" && known.version === version) {
    const cached = await readCached(name);
    if (cached) return { ok: true, jpeg: cached };
  }
  const running = rendering.get(name);
  if (running) return running;
  const started = (async (): Promise<Largest> => {
    const drawn = await PosterRender.master(
      source,
      file,
      new AbortController().signal,
    );
    switch (drawn.kind) {
      case "ready":
        await store(name, drawn.master.jpeg);
        remember(ctx, item.id, version, {
          state: "ready",
          size: drawn.master.source,
        });
        return { ok: true, jpeg: drawn.master.jpeg };
      case "timed_out": {
        // A busy server can cause one: tried once more later, then remembered as failed.
        const again = known?.state === "timed_out" && known.version === version;
        console.warn(
          `[library-api] A poster render ran out of time${again ? " again; it is not tried until the file changes" : `; it is tried again in ${TIMEOUT_RETRY_MS / 60_000} minutes`}.`,
        );
        remember(ctx, item.id, version, {
          state: again ? "failed" : "timed_out",
        });
        return { ok: false, error: failed };
      }
      case "failed":
        // Names only: the item and its path stay out of the log.
        console.warn(
          `[library-api] A poster could not be drawn (${drawn.cause instanceof Error ? drawn.cause.name : typeof drawn.cause}); it is not tried again until the file changes.`,
        );
        remember(ctx, item.id, version, { state: "failed" });
        return { ok: false, error: failed };
      case "busy":
        return { ok: false, error: busy };
      case "changed":
        return { ok: false, error: changed };
      case "unavailable":
        return { ok: false, error: notAvailable };
    }
  })();
  rendering.set(name, started);
  try {
    return await started;
  } finally {
    rendering.delete(name);
  }
}

/** Each device's own bound on posters being drawn, dropped while it has none. */
const devices = new Map<
  string,
  {
    run: ReturnType<typeof createLimiter>;
    users: number;
  }
>();

async function forDevice<T>(
  deviceId: string,
  signal: AbortSignal,
  task: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: LibraryApiError }> {
  const entry = devices.get(deviceId) ?? {
    run: createLimiter(DEVICE_CONCURRENCY, DEVICE_QUEUE, busy.message),
    users: 0,
  };
  devices.set(deviceId, entry);
  entry.users++;
  try {
    return { ok: true, value: await entry.run(task, signal) };
  } catch (error) {
    if (error instanceof TRPCError && error.code === "TOO_MANY_REQUESTS")
      return { ok: false, error: busy };
    // The device left while its request waited; nothing is drawn for it.
    if (error instanceof DOMException && error.name === "AbortError")
      return {
        ok: false,
        error: {
          code: "service_unavailable",
          message: "The request was cancelled.",
        },
      };
    throw error;
  } finally {
    entry.users--;
    if (entry.users === 0) devices.delete(deviceId);
  }
}

/** Whether `If-None-Match` names `etag`. */
function matches(request: Request, etag: string) {
  const header = request.headers.get("if-none-match");
  return (
    header !== null &&
    header
      .split(",")
      .some(
        (tag) => tag.trim() === "*" || tag.trim().replace(/^W\//, "") === etag,
      )
  );
}

/** The poster of item `itemId` at `width` for a device whose request has been authorized. */
async function respond(
  ctx: Pick<LibraryContext, "db" | "now">,
  request: Request,
  device: { id: string },
  scope: LibraryScope,
  itemId: string,
  width: PosterWidth,
): Promise<Response> {
  // Opened first, so an item whose file is gone or became a link answers as an unknown id does.
  const opened = await LibraryAccess.open(ctx, scope, itemId);
  if (!opened.ok) return LibraryApiError.response(opened.error);
  const { item, opened: file } = opened.value;
  try {
    const source = drawable(path.posix.basename(item.path));
    if (source === null) return LibraryApiError.response(notAvailable);
    const version = LibraryCatalog.versionOf(file.stats);
    const etag = `"poster-${FORMAT}-${version}-${width}"`;
    const cacheHeaders = {
      ETag: etag,
      "Cache-Control": "private, no-cache",
      "X-Content-Type-Options": "nosniff",
    };
    const failedBefore = (known: PosterRecord | null) =>
      known?.version === version &&
      (known.state === "failed" ||
        (known.state === "timed_out" &&
          ctx.now() - known.recordedAt < TIMEOUT_RETRY_MS));
    const known = recordOf(ctx, item.id);
    if (failedBefore(known)) return LibraryApiError.response(failed);
    // Only a version known to have a poster is unchanged; `*` matches nothing before that.
    if (
      known?.state === "ready" &&
      known.version === version &&
      matches(request, etag)
    )
      return new Response(null, { status: 304, headers: cacheHeaders });
    const name = cacheName(item, file, width);
    const answer = (body: Uint8Array<ArrayBuffer> | null, length: number) =>
      new Response(body, {
        headers: {
          ...cacheHeaders,
          "Content-Type": "image/jpeg",
          "Content-Length": String(length),
          "Content-Security-Policy": "sandbox; default-src 'none'",
        },
      });
    // HEAD reads no bytes when the poster is cached; GET reads them in the device's turn.
    if (request.method === "HEAD") {
      const size = await cachedSize(name);
      if (size !== null) return answer(null, size);
    }
    const drawn = await forDevice(
      device.id,
      request.signal,
      async (): Promise<Largest> => {
        const cached = await readCached(name);
        if (cached) return { ok: true, jpeg: cached };
        // Read again: another request may have drawn it, or failed, while this one waited.
        const latest = recordOf(ctx, item.id);
        if (failedBefore(latest)) return { ok: false, error: failed };
        const big = await largest(ctx, item, file, source, version, latest);
        if (!big.ok || width === LARGEST) return big;
        const jpeg = await PosterRender.scaled(big.jpeg, width);
        await store(name, jpeg);
        return { ok: true, jpeg };
      },
    );
    if (!drawn.ok) return LibraryApiError.response(drawn.error);
    if (!drawn.value.ok) return LibraryApiError.response(drawn.value.error);
    const { jpeg } = drawn.value;
    return answer(request.method === "HEAD" ? null : jpeg, jpeg.byteLength);
  } finally {
    await file.handle.close();
  }
}

export const LibraryPosters = {
  parseWidth,
  listed,
  respond,

  /** What was recorded for the posters of library `libraryId`'s items, by item id. */
  known(ctx: Pick<LibraryContext, "db">, libraryId: string) {
    const known = new Map<string, PosterRecord>();
    for (const { poster } of rowsFor(ctx, libraryId)) {
      const found = record(poster);
      if (found) known.set(poster.itemId, found);
    }
    return known;
  },

  /** What was recorded for item `itemId`'s poster, if anything. */
  knownFor(ctx: Pick<LibraryContext, "db">, itemId: string) {
    return recordOf(ctx, itemId) ?? undefined;
  },
} as const;
