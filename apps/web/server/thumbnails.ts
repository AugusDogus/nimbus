import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import sharp from "sharp";
import { isFsError } from "@nimbus/api/safe-path";
import type { FileKind } from "@/lib/file-kind";

/** A file on disk whose thumbnail is requested. */
export type ThumbnailSource = {
  absolute: string;
  relative: string;
  size: number;
  mtimeMs: number;
  kind: FileKind;
};

export type ThumbnailResult =
  | { type: "ready"; body: Uint8Array }
  | { type: "unavailable" };

/*
 * Thumbnails and posters hand sharp a descriptor's /proc/<pid>/fd/<n> name, and descriptor
 * numbers are reused for other files. libvips caches operations by file name, so a later load
 * could be answered with an earlier file's pixels or size. Every descriptor-backed sharp load
 * imports this module, so turning the cache off here covers them all before the first one.
 */
sharp.cache(false);

/** Produces a WebP thumbnail. Abort means every requester left: stop work. */
export type ThumbnailRenderer = (
  absolute: string,
  signal: AbortSignal,
) => Promise<Uint8Array>;

type RendererKind = "image" | "pdf" | "video";

export const THUMBNAIL_SIZE = 256;
const FORMAT_VERSION = 1;
// Matches the decoded-pixel bound used before this module; about 160 MB of RGBA.
export const MAX_INPUT_PIXELS = 40_000_000;
/** How long a file whose render timed out shows its generic icon before one more try. */
const timeoutRetryMs = 10 * 60 * 1000;

/** Content-addressed: changes whenever the file's path, mtime or size do. */
export function thumbnailTag(
  source: Pick<ThumbnailSource, "relative" | "mtimeMs" | "size">,
) {
  return createHash("sha256")
    .update(
      `${FORMAT_VERSION}\0${source.relative}\0${source.mtimeMs}\0${source.size}`,
    )
    .digest("hex");
}

/**
 * A render that ran out of time. A busy server can cause it as well as a hostile file, so it
 * is retried once later instead of being remembered as a file that cannot be rendered.
 */
export class ThumbnailTimeout extends Error {
  override name = "ThumbnailTimeout";
}

/** Resize an already decodable still image to the final WebP thumbnail. */
export async function finishThumbnail(input: string | Uint8Array) {
  try {
    return await sharp(input, {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: "error",
    })
      .rotate()
      .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 75 })
      .timeout({ seconds: 10 })
      .toBuffer();
  } catch (error) {
    // libvips reports its deadline as "timeout: N% complete".
    if (
      error instanceof Error &&
      /\btimeout: \d+% complete/.test(error.message)
    )
      throw new ThumbnailTimeout(error.message, { cause: error });
    throw error;
  }
}

export const imageRenderer: ThumbnailRenderer = (absolute) =>
  finishThumbnail(absolute);

type Job = {
  waiters: number;
  controller: AbortController;
  promise: Promise<ThumbnailResult>;
};

function abortError() {
  return new DOMException("The thumbnail request was cancelled.", "AbortError");
}

/**
 * Runs at most `limit` tasks at once and keeps at most `maxQueued` waiting, refusing more with
 * `busy`. Queued tasks whose signal aborts leave the queue without running.
 */
export function createLimiter(limit: number, maxQueued: number, busy: string) {
  let running = 0;
  const queue: { start: () => void; signal: AbortSignal }[] = [];
  // The slot is taken here, before the waiter resumes, so one finished task
  // cannot release more waiters than there are free slots.
  const next = () => {
    while (running < limit && queue.length) {
      const item = queue.shift();
      if (item && !item.signal.aborted) {
        running++;
        item.start();
      }
    }
  };
  return async <T>(task: () => Promise<T>, signal: AbortSignal) => {
    if (signal.aborted) throw abortError();
    if (running >= limit) {
      if (queue.length >= maxQueued)
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: busy });
      await new Promise<void>((resolve, reject) => {
        const item = { start: resolve, signal };
        queue.push(item);
        signal.addEventListener(
          "abort",
          () => {
            const index = queue.indexOf(item);
            if (index >= 0) queue.splice(index, 1);
            reject(abortError());
          },
          { once: true },
        );
      });
    } else running++;
    try {
      return await task();
    } finally {
      running--;
      next();
    }
  };
}

export function createThumbnailer({
  cacheDirectory,
  renderers,
  concurrency = Math.max(
    1,
    Math.min(4, Math.floor(availableParallelism() / 2)),
  ),
  maxQueued = 256,
}: {
  cacheDirectory: string;
  renderers: Partial<Record<RendererKind, ThumbnailRenderer>>;
  concurrency?: number;
  maxQueued?: number;
}) {
  const limit = createLimiter(
    concurrency,
    maxQueued,
    "Thumbnails are still being generated for other files. They will load when you scroll back or refresh.",
  );
  const jobs = new Map<string, Job>();

  async function readCached(tag: string): Promise<ThumbnailResult | null> {
    try {
      return {
        type: "ready",
        body: new Uint8Array(
          await readFile(path.join(cacheDirectory, `${tag}.webp`)),
        ),
      };
    } catch (error) {
      if (!isFsError(error, "ENOENT")) throw error;
    }
    try {
      await readFile(path.join(cacheDirectory, `${tag}.failed`));
      return { type: "unavailable" };
    } catch (error) {
      if (!isFsError(error, "ENOENT")) throw error;
    }
    // A recent timeout: wait before trying again, so a busy server is not loaded further.
    const timedOut = await timedOutAt(tag);
    if (timedOut !== null && Date.now() - timedOut < timeoutRetryMs)
      return { type: "unavailable" };
    return null;
  }

  async function timedOutAt(tag: string) {
    try {
      return (await stat(path.join(cacheDirectory, `${tag}.timeout`))).mtimeMs;
    } catch (error) {
      if (isFsError(error, "ENOENT")) return null;
      throw error;
    }
  }

  async function store(filename: string, body: Uint8Array) {
    await mkdir(cacheDirectory, { recursive: true });
    const temporary = path.join(cacheDirectory, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, body);
      await rename(temporary, path.join(cacheDirectory, filename));
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async function generate(
    source: ThumbnailSource,
    tag: string,
    render: ThumbnailRenderer,
    signal: AbortSignal,
  ): Promise<ThumbnailResult> {
    return limit(async () => {
      let body: Uint8Array;
      try {
        body = await render(source.absolute, signal);
      } catch (error) {
        if (signal.aborted) throw abortError();
        if (
          error instanceof ThumbnailTimeout &&
          (await timedOutAt(tag)) === null
        ) {
          console.warn(
            `Nimbus ran out of time creating a thumbnail for "${source.relative}". It will try again in ${timeoutRetryMs / 60_000} minutes; a generic icon is shown meanwhile.`,
          );
          await store(`${tag}.timeout`, new Uint8Array());
          return { type: "unavailable" };
        }
        // Corrupt or hostile input, or a second timeout: remember it until the file changes.
        console.warn(
          `Nimbus could not create a thumbnail for "${source.relative}". The file is unchanged; a generic icon is shown instead.`,
          error,
        );
        await store(`${tag}.failed`, new Uint8Array());
        return { type: "unavailable" };
      }
      await store(`${tag}.webp`, body);
      await rm(path.join(cacheDirectory, `${tag}.timeout`), { force: true });
      return { type: "ready", body };
    }, signal);
  }

  return {
    async get(
      source: ThumbnailSource,
      signal: AbortSignal,
    ): Promise<ThumbnailResult> {
      const kind = source.kind.type;
      const render =
        kind === "image" || kind === "pdf" || kind === "video"
          ? renderers[kind]
          : undefined;
      if (!render) return { type: "unavailable" };
      const tag = thumbnailTag(source);
      const cached = await readCached(tag);
      if (cached) return cached;
      let job = jobs.get(tag);
      if (!job) {
        const controller = new AbortController();
        const promise = generate(source, tag, render, controller.signal);
        const created: Job = { waiters: 0, controller, promise };
        void promise.then(
          () => jobs.delete(tag),
          () => jobs.delete(tag),
        );
        jobs.set(tag, created);
        job = created;
      }
      const current = job;
      current.waiters++;
      const leave = () => {
        current.waiters--;
        if (current.waiters === 0) current.controller.abort();
      };
      return new Promise<ThumbnailResult>((resolve, reject) => {
        const onAbort = () => {
          leave();
          reject(abortError());
        };
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        current.promise
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", onAbort));
      });
    },
  };
}
