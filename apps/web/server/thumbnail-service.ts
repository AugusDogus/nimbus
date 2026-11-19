import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { DriveFile } from "@nimbus/api/drive-file";
import { getConfigRoot } from "./storage-paths";
import { pdfRenderer, videoRenderer } from "./thumbnail-renderers";
import {
  createThumbnailer,
  imageRenderer,
  type ThumbnailRenderer,
} from "./thumbnails";

/** Linux names every open descriptor of this process under /proc, for its children too. */
const descriptorPaths = existsSync("/proc/self/fd");

/**
 * `render` reading the file through a descriptor opened without following symlinks, so a
 * symlink swapped in after the path was checked never feeds another file to a decoder. The
 * decoders, in process or as child processes, open the descriptor's /proc path; elsewhere they
 * open the checked path itself.
 */
export const fromVerifiedFile =
  <T>(
    render: (absolute: string, signal: AbortSignal) => Promise<T>,
  ): ((absolute: string, signal: AbortSignal) => Promise<T>) =>
  async (absolute, signal) => {
    const { handle } = await DriveFile.openFile(absolute);
    try {
      return await render(
        descriptorPaths ? `/proc/${process.pid}/fd/${handle.fd}` : absolute,
        signal,
      );
    } finally {
      await handle.close();
    }
  };

let shared: ReturnType<typeof createThumbnailer> | null = null;

/** One process-wide thumbnailer so the concurrency bound covers every request. */
export function thumbnailer() {
  if (!shared) {
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
    > = { image: fromVerifiedFile(imageRenderer) };
    if (limited && pdftoppm)
      renderers.pdf = fromVerifiedFile(pdfRenderer(pdftoppm));
    if (limited && ffmpeg)
      renderers.video = fromVerifiedFile(videoRenderer(ffmpeg));
    const missing = [
      !limited && "prlimit (util-linux)",
      !pdftoppm && "pdftoppm (poppler-utils) for PDFs",
      !ffmpeg && "ffmpeg for videos",
    ].filter(Boolean);
    if (missing.length)
      console.warn(
        `Nimbus thumbnails: ${missing.join(", ")} not found on PATH. Those files show generic icons; previews and downloads are unaffected. The Docker image includes them.`,
      );
    shared = createThumbnailer({
      cacheDirectory: path.join(getConfigRoot(), "cache", "thumbnails"),
      renderers,
    });
  }
  return shared;
}
