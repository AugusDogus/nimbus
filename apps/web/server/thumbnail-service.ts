import "server-only";

import path from "node:path";
import sharp from "sharp";
import { getConfigRoot } from "./storage-paths";
import { pdfRenderer, videoRenderer } from "./thumbnail-renderers";
import {
  createThumbnailer,
  imageRenderer,
  type ThumbnailRenderer,
} from "./thumbnails";

declare global {
  var __nimbusThumbnailer: ReturnType<typeof createThumbnailer> | undefined;
}

/** One process-wide thumbnailer so the concurrency bound covers every request. */
export function thumbnailer() {
  if (!globalThis.__nimbusThumbnailer) {
    // Parallelism comes from the job limit; one libvips thread per job keeps
    // a folder of thousands of images from saturating every core.
    sharp.concurrency(1);
    // Decoders run as bounded subprocesses. Without one installed, files of
    // that kind keep their generic icon.
    const pdftoppm = Bun.which("pdftoppm");
    const ffmpeg = Bun.which("ffmpeg");
    const limited = Bun.which("prlimit") !== null;
    const renderers: Partial<
      Record<"image" | "pdf" | "video", ThumbnailRenderer>
    > = { image: imageRenderer };
    if (limited && pdftoppm) renderers.pdf = pdfRenderer(pdftoppm);
    if (limited && ffmpeg) renderers.video = videoRenderer(ffmpeg);
    const missing = [
      !limited && "prlimit (util-linux)",
      !pdftoppm && "pdftoppm (poppler-utils) for PDFs",
      !ffmpeg && "ffmpeg for videos",
    ].filter(Boolean);
    if (missing.length)
      console.warn(
        `Nimbus thumbnails: ${missing.join(", ")} not found on PATH. Those files show generic icons; previews and downloads are unaffected. The Docker image includes them.`,
      );
    globalThis.__nimbusThumbnailer = createThumbnailer({
      cacheDirectory: path.join(getConfigRoot(), "cache", "thumbnails"),
      renderers,
    });
  }
  return globalThis.__nimbusThumbnailer;
}
