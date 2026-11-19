import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import type { OpenedDriveFile } from "@nimbus/api/drive-file";
import { PdfPages } from "@/lib/pdf-pages";
import { FileVersion } from "./file-version";
import { runBounded } from "./thumbnail-renderers";
import { createLimiter } from "./thumbnails";

/** A page size when pdfinfo leaves one out: US Letter, in points. */
const letter = { width: 612, height: 792 };

/**
 * The page count and page sizes in `pdfinfo -f 1 -l <n>` output, or null when it names no
 * page count. Document metadata such as the title comes first and may contain any text, so
 * reading starts at the last `Pages:` line, which pdfinfo prints after it.
 */
function parseInfo(output: string): Omit<PdfPages, "version"> | null {
  const lines = output.split("\n");
  const start = lines.findLastIndex((line) => /^Pages:\s+\d+\s*$/.test(line));
  const count = Number(/\d+/.exec(lines[start] ?? "")?.[0]);
  if (start < 0 || !Number.isSafeInteger(count) || count < 1) return null;
  const sizes = Array.from(
    { length: Math.min(count, PdfPages.maxPages) },
    () => ({ ...letter }),
  );
  for (const line of lines.slice(start + 1)) {
    const size = /^Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+) pts/.exec(line);
    const rotation = /^Page\s+(\d+) rot:\s+(\d+)/.exec(line);
    const page = sizes[Number((size ?? rotation)?.[1]) - 1];
    if (!page) continue;
    if (size) {
      const width = Number(size[2]);
      const height = Number(size[3]);
      if (width > 0 && height > 0 && Number.isFinite(width + height))
        Object.assign(page, { width, height });
    } else if (rotation && Number(rotation[2]) % 180 === 90)
      Object.assign(page, { width: page.height, height: page.width });
  }
  return { count, sizes };
}

/** Thrown when Poppler is not installed, so pages cannot be rendered at all. */
export class PdfRenderUnavailable extends Error {
  override name = "PdfRenderUnavailable";
}

/** Poppler refused the file or ran out of time; the cause says which. */
export class PdfRenderFailed extends Error {
  override name = "PdfRenderFailed";
}

/** The file was written while Poppler read it, so the output may mix two versions. */
export class PdfChanged extends Error {
  override name = "PdfChanged";
}

/**
 * A PDF opened once, without following symlinks, and the stats of that open file, which name
 * its version. Everything rendered comes from this descriptor.
 */
export type OpenedPdf = Pick<OpenedDriveFile, "handle" | "stats">;

/** Runs `work`, reporting its failures as `PdfRenderFailed` unless the request left. */
async function rendering<T>(
  what: string,
  signal: AbortSignal,
  work: () => Promise<T>,
) {
  try {
    return await work();
  } catch (error) {
    if (signal.aborted || error instanceof PdfRenderUnavailable) throw error;
    throw new PdfRenderFailed(`Rendering ${what} failed.`, { cause: error });
  }
}

/** Linux names each open descriptor under /proc, where a child process can open it too. */
const descriptorPaths = existsSync("/proc/self/fd");

/** Poppler's tools, or null where pages cannot be rendered at all. */
const installed = () => {
  const pdfinfo = Bun.which("pdfinfo");
  const pdftoppm = Bun.which("pdftoppm");
  return pdfinfo && pdftoppm && Bun.which("prlimit") && descriptorPaths
    ? { pdfinfo, pdftoppm }
    : null;
};

const tools = () => {
  const found = installed();
  if (!found)
    throw new PdfRenderUnavailable(
      "This server cannot render PDF pages: pdfinfo, pdftoppm (poppler-utils) or prlimit (util-linux) is not installed, or /proc is not mounted. The Docker image includes them. Open the PDF in a new tab or download it instead.",
    );
  return found;
};

/**
 * Runs Poppler on the open descriptor itself, so a file renamed over the path is never read,
 * then checks the descriptor's file is still the `FileVersion` it was opened as: a write in
 * place, even one that restores the modification time, moves its change time. Either way the
 * output describes exactly the version `file.stats` names, or the request is refused. A file
 * renamed over the path also moves the opened file's change time, so it is refused too.
 *
 * That check is a render's last wait: the routes build their answer from its output without
 * waiting again. So a request that left by then gets its abort, never an answer, and a view
 * counted for it is given back.
 */
async function fromOpened<T>(
  file: OpenedPdf,
  signal: AbortSignal,
  run: (source: string) => Promise<T>,
) {
  const output = await run(`/proc/${process.pid}/fd/${file.handle.fd}`);
  const now = await file.handle.stat();
  if (signal.aborted)
    throw new DOMException("The request was cancelled.", "AbortError");
  if (FileVersion.of(file.stats) !== FileVersion.of(now))
    throw new PdfChanged(
      "The PDF changed while its pages were drawn. Reload to see the current version.",
    );
  return output;
}

// Each render is a short process; a few at once keep scrolling smooth without taking every core.
const limit = createLimiter(
  Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))),
  64,
  "Nimbus is rendering many PDF pages right now. Scroll back to this page to load it.",
);

async function info(file: OpenedPdf, signal: AbortSignal) {
  const { pdfinfo } = tools();
  const output = await limit(
    () =>
      fromOpened(file, signal, (source) =>
        rendering("the page list", signal, () =>
          runBounded(
            [pdfinfo, "-f", "1", "-l", String(PdfPages.maxPages), source],
            {
              timeoutMs: 10_000,
              memoryBytes: 512 * 1024 * 1024,
              cpuSeconds: 5,
              maxOutputBytes: 1024 * 1024,
            },
            signal,
          ),
        ),
      ),
    signal,
  );
  const parsed = parseInfo(new TextDecoder().decode(output));
  if (!parsed) throw new PdfRenderFailed("pdfinfo printed no page count.");
  return parsed;
}

/**
 * Poppler scales while drawing, so a large page never exists at full size, and encodes the
 * JPEG itself: no page's pixels pass through this process. Decoding them here with sharp
 * left about 300 MB of fragmented native heap after a few hundred pages.
 */
function page(
  file: OpenedPdf,
  number: number,
  width: number,
  signal: AbortSignal,
) {
  const { pdftoppm } = tools();
  return limit(
    () =>
      fromOpened(file, signal, (source) =>
        rendering(`page ${number}`, signal, () =>
          runBounded(
            [
              pdftoppm,
              "-f",
              String(number),
              "-l",
              String(number),
              "-singlefile",
              "-scale-to-x",
              String(width),
              "-scale-to-y",
              "-1",
              // The width is the page's as shown; otherwise Poppler applies it before rotating.
              "-scale-dimension-before-rotation",
              "-jpeg",
              // Progressive images show the whole page early on a slow connection.
              "-jpegopt",
              "quality=80,optimize=y,progressive=y",
              source,
            ],
            {
              timeoutMs: 15_000,
              memoryBytes: 1024 * 1024 * 1024,
              cpuSeconds: 10,
              maxOutputBytes: 16 * 1024 * 1024,
            },
            signal,
          ),
        ),
      ),
    signal,
  );
}

/**
 * Pages of an opened PDF, through bounded Poppler processes. Inputs are untrusted user files.
 * Callers check access before calling: these take a render slot.
 */
export const PdfRender = {
  parseInfo,
  /** Whether this server can render pages at all, checked before a view is counted. */
  available: () => installed() !== null,
  /** The page count and the sizes of the first pages. */
  info,
  /** Page `number` (from 1) as a JPEG image `width` pixels wide. */
  page,
} as const;
