import "server-only";

import path from "node:path";
import sharp from "sharp";
import { getConfigRoot } from "./storage-paths";
import { createThumbnailer, imageRenderer } from "./thumbnails";

declare global {
  var __nimbusThumbnailer: ReturnType<typeof createThumbnailer> | undefined;
}

/** One process-wide thumbnailer so the concurrency bound covers every request. */
export function thumbnailer() {
  if (!globalThis.__nimbusThumbnailer) {
    // Parallelism comes from the job limit; one libvips thread per job keeps
    // a folder of thousands of images from saturating every core.
    sharp.concurrency(1);
    globalThis.__nimbusThumbnailer = createThumbnailer({
      cacheDirectory: path.join(getConfigRoot(), "cache", "thumbnails"),
      renderers: { image: imageRenderer },
    });
  }
  return globalThis.__nimbusThumbnailer;
}
