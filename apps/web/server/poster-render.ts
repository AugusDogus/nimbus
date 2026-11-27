import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { TRPCError } from "@trpc/server";
import sharp from "sharp";
import type { OpenedDriveFile } from "@nimbus/api/drive-file";
import { FileKind } from "@/lib/file-kind";
import { hasThumbnail } from "@/lib/thumbnail-kind";
import { FileVersion } from "./file-version";
import {
  PdfChanged,
  PdfRender,
  PdfRenderFailed,
  PdfRenderUnavailable,
} from "./pdf-render";
import { paddedSize, videoFrame } from "./thumbnail-renderers";
import {
  createLimiter,
  MAX_INPUT_PIXELS,
  ThumbnailTimeout,
} from "./thumbnails";

/**
 * Posters: one still JPEG per file version, drawn by the thumbnail decoders (bounded FFmpeg and
 * Poppler subprocesses, sharp in process) from a descriptor opened without following symlinks.
 * A poster fits inside `POSTER_MAX` and is never larger than its source; smaller posters are
 * scaled from it. Callers authorize the file first: a render takes a decoder slot.
 */
export type PosterSource = "video" | "pdf" | "image";

export type Dimensions = { width: number; height: number };

/** The largest poster. Wide enough for a large screen; tall enough for a portrait page. */
export const POSTER_MAX: Dimensions = { width: 1920, height: 3840 };

export const POSTER_QUALITY = 80;

export type PosterMaster = {
  /** The largest poster, as a JPEG. */
  jpeg: Uint8Array<ArrayBuffer>;
  /** Its size. */
  size: Dimensions;
  /**
   * The source's own size: a video frame's display size, an image's size once its EXIF
   * orientation applies, a document page's size in points.
   */
  source: Dimensions;
};

export type PosterRenderResult =
  | { kind: "ready"; master: PosterMaster }
  /** The decoder refused the file or produced nothing usable; `cause` is for the log. */
  | { kind: "failed"; cause: unknown }
  | { kind: "timed_out" }
  /** Every decoder slot is taken and the queue is full. */
  | { kind: "busy" }
  /** The file was written while it was drawn, so the output may mix two versions. */
  | { kind: "changed" }
  /** This server lacks the decoder. */
  | { kind: "unavailable" }
  /** `signal` aborted: everyone who asked for it left. */
  | { kind: "cancelled" };

/** Linux names each open descriptor under /proc, where a child process can open it too. */
const descriptorPaths = existsSync("/proc/self/fd");

let tools: { ffmpeg: string | null; limited: boolean } | null = null;
const installed = () => {
  tools ??= {
    ffmpeg: Bun.which("ffmpeg"),
    limited: Bun.which("prlimit") !== null,
  };
  return tools;
};

/** What a poster of the file named `name` is drawn from, or null when it has none. */
function sourceOf(name: string): PosterSource | null {
  if (!hasThumbnail(name)) return null;
  const { type } = FileKind.of(name);
  return type === "video" || type === "pdf" || type === "image" ? type : null;
}

/** Whether this server can draw posters from `source` at all. Never touches a file. */
function available(source: PosterSource) {
  if (!descriptorPaths) return false;
  if (source === "pdf") return PdfRender.available();
  if (source === "video")
    return installed().ffmpeg !== null && installed().limited;
  return true;
}

// Each render is one decoder process or one sharp pipeline; a few at once leave cores free.
const limit = createLimiter(
  Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))),
  256,
  "Nimbus is drawing many posters right now.",
);

/** Seconds into a video its poster is taken from, in order: a few seconds in, then nearer the start. */
const VIDEO_OFFSETS = [3, 1, 0] as const;

/**
 * The frame at its display size (square pixels), shrunk to fit one pixel past `POSTER_MAX` so a
 * frame that had to shrink can be told from one that did not. Made opaque, then given one
 * transparent column on the right: the raw output has no header, and that column marks where
 * each row ends.
 */
const masterFilter = [
  "scale=w='round(iw*sar)':h=ih",
  "setsar=1",
  `scale=w='min(${POSTER_MAX.width + 1},iw)':h='min(${POSTER_MAX.height + 1},ih)':force_original_aspect_ratio=decrease`,
  "format=rgb24",
  "format=rgba",
  "pad=w=iw+1:h=ih:x=0:y=0:color=black@0",
].join(",");
const masterBytes = (POSTER_MAX.width + 2) * (POSTER_MAX.height + 1) * 4;

/** The frame's display width alone, as one row. Wider sources are refused. */
const widthFilter = "scale=w='round(iw*sar)':h=1";
const widthBytes = 65_536 * 4;

const fits = (size: Dimensions) =>
  size.width <= POSTER_MAX.width && size.height <= POSTER_MAX.height;

async function videoMaster(
  ffmpeg: string,
  file: string,
  signal: AbortSignal,
): Promise<PosterMaster> {
  for (const seconds of VIDEO_OFFSETS) {
    const raw = await videoFrame(
      ffmpeg,
      file,
      seconds,
      masterFilter,
      masterBytes,
      signal,
    );
    // Shorter than `seconds`: try nearer the start.
    if (raw.byteLength === 0) continue;
    const frame = paddedSize(raw);
    if (!frame)
      throw new Error(
        `FFmpeg produced ${raw.byteLength} bytes of no frame size.`,
      );
    let source = frame;
    if (!fits(frame)) {
      // Shrunk to fit: the display width from a one-row frame, the height from the aspect.
      const row = await videoFrame(
        ffmpeg,
        file,
        seconds,
        widthFilter,
        widthBytes,
        signal,
      );
      if (row.byteLength === 0 || row.byteLength % 4 !== 0)
        throw new Error(`FFmpeg produced ${row.byteLength} bytes for one row.`);
      const width = row.byteLength / 4;
      source = {
        width,
        height: Math.max(1, Math.round((width * frame.height) / frame.width)),
      };
    }
    const { data, info } = await sharp(raw, {
      raw: { width: frame.width + 1, height: frame.height, channels: 4 },
    })
      .extract({ left: 0, top: 0, ...frame })
      .removeAlpha()
      .resize({
        ...POSTER_MAX,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: POSTER_QUALITY })
      .toBuffer({ resolveWithObject: true });
    return {
      jpeg: new Uint8Array(data),
      size: { width: info.width, height: info.height },
      source,
    };
  }
  throw new Error("FFmpeg found no video frame to draw.");
}

const IMAGE_DEADLINE_SECONDS = 10;

async function imageMaster(file: string): Promise<PosterMaster> {
  const options = {
    limitInputPixels: MAX_INPUT_PIXELS,
    failOn: "error",
  } as const;
  // Under the render's own deadline. libvips cannot stop it, but the request stops waiting.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const metadata = await Promise.race([
    sharp(file, options).metadata(),
    new Promise<never>((_, reject) => {
      deadline = setTimeout(
        () =>
          reject(
            new ThumbnailTimeout(
              "Reading the image's size took over 10 seconds.",
            ),
          ),
        IMAGE_DEADLINE_SECONDS * 1000,
      );
    }),
  ]).finally(() => clearTimeout(deadline));
  // EXIF orientations 5 to 8 turn the image a quarter.
  const turned = (metadata.orientation ?? 1) >= 5;
  const source = turned
    ? { width: metadata.height, height: metadata.width }
    : { width: metadata.width, height: metadata.height };
  try {
    const { data, info } = await sharp(file, options)
      .rotate()
      .resize({ ...POSTER_MAX, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: POSTER_QUALITY })
      .timeout({ seconds: IMAGE_DEADLINE_SECONDS })
      .toBuffer({ resolveWithObject: true });
    return {
      jpeg: new Uint8Array(data),
      size: { width: info.width, height: info.height },
      source,
    };
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

async function pdfMaster(
  file: OpenedDriveFile,
  signal: AbortSignal,
): Promise<PosterMaster> {
  const [page] = (await PdfRender.info(file, signal)).sizes;
  if (!page) throw new Error("pdfinfo listed no first page.");
  // A page has no pixels: drawn as wide as a poster may be, unless that would make it too tall.
  const width = Math.max(
    1,
    Math.min(
      POSTER_MAX.width,
      Math.floor((POSTER_MAX.height * page.width) / page.height),
    ),
  );
  const jpeg = await PdfRender.page(file, 1, width, signal);
  const metadata = await sharp(jpeg).metadata();
  return {
    jpeg: new Uint8Array(jpeg),
    size: { width: metadata.width, height: metadata.height },
    source: {
      width: Math.max(1, Math.round(page.width)),
      height: Math.max(1, Math.round(page.height)),
    },
  };
}

const timedOut = (error: unknown) =>
  error instanceof ThumbnailTimeout ||
  (error instanceof PdfRenderFailed && error.cause instanceof ThumbnailTimeout);

/**
 * The largest poster of `file`, an opened `source`. Video and image renders take a slot of
 * this module's limiter; PDF pages take the page renderer's own, shared with the PDF viewer.
 */
async function master(
  source: PosterSource,
  file: OpenedDriveFile,
  signal: AbortSignal,
): Promise<PosterRenderResult> {
  const { ffmpeg } = installed();
  if (!available(source) || (source === "video" && ffmpeg === null))
    return { kind: "unavailable" };
  const descriptor = `/proc/${process.pid}/fd/${file.handle.fd}`;
  try {
    let drawn: PosterMaster;
    if (source === "pdf") drawn = await pdfMaster(file, signal);
    else {
      drawn = await limit(
        () =>
          source === "video" && ffmpeg !== null
            ? videoMaster(ffmpeg, descriptor, signal)
            : imageMaster(descriptor),
        signal,
      );
      // The PDF renderer checks this itself.
      if (
        FileVersion.of(file.stats) !== FileVersion.of(await file.handle.stat())
      )
        return { kind: "changed" };
    }
    if (drawn.source.width < 1 || drawn.source.height < 1)
      return { kind: "failed", cause: new Error("The source has no size.") };
    return { kind: "ready", master: drawn };
  } catch (error) {
    // Checked first: a decoder killed on abort would otherwise read as a file it cannot draw.
    if (signal.aborted) return { kind: "cancelled" };
    if (error instanceof TRPCError && error.code === "TOO_MANY_REQUESTS")
      return { kind: "busy" };
    if (error instanceof PdfRenderUnavailable) return { kind: "unavailable" };
    if (error instanceof PdfChanged) return { kind: "changed" };
    if (timedOut(error)) return { kind: "timed_out" };
    return { kind: "failed", cause: error };
  }
}

/** `jpeg`, a largest poster, scaled to at most `width` pixels wide; never enlarged. */
async function scaled(jpeg: Uint8Array<ArrayBuffer>, width: number) {
  if ((await sharp(jpeg).metadata()).width <= width) return jpeg;
  return new Uint8Array(
    await sharp(jpeg)
      .resize({ width, withoutEnlargement: true })
      .jpeg({ quality: POSTER_QUALITY })
      .toBuffer(),
  );
}

export const PosterRender = {
  sourceOf,
  available,
  master,
  scaled,
} as const;
