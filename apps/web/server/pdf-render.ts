import { availableParallelism } from "node:os";
import { PdfPages } from "@/lib/pdf-pages";
import { runBounded } from "./thumbnail-renderers";
import { fromVerifiedFile } from "./thumbnail-service";
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

const tools = () => {
  const pdfinfo = Bun.which("pdfinfo");
  const pdftoppm = Bun.which("pdftoppm");
  if (!pdfinfo || !pdftoppm || !Bun.which("prlimit"))
    throw new PdfRenderUnavailable(
      "This server cannot render PDF pages: pdfinfo, pdftoppm (poppler-utils) or prlimit (util-linux) is not installed. The Docker image includes them. Open the PDF in a new tab or download it instead.",
    );
  return { pdfinfo, pdftoppm };
};

// Each render is a short process; a few at once keep scrolling smooth without taking every core.
const limit = createLimiter(
  Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))),
  64,
  "Nimbus is rendering many PDF pages right now. Scroll back to this page to load it.",
);

const info = fromVerifiedFile(async (absolute, signal) => {
  const output = await limit(
    () =>
      rendering("the page list", signal, () =>
        runBounded(
          [
            tools().pdfinfo,
            "-f",
            "1",
            "-l",
            String(PdfPages.maxPages),
            absolute,
          ],
          {
            timeoutMs: 10_000,
            memoryBytes: 512 * 1024 * 1024,
            cpuSeconds: 5,
            maxOutputBytes: 1024 * 1024,
          },
          signal,
        ),
      ),
    signal,
  );
  const parsed = parseInfo(new TextDecoder().decode(output));
  if (!parsed) throw new PdfRenderFailed("pdfinfo printed no page count.");
  return parsed;
});

/**
 * Poppler scales while drawing, so a large page never exists at full size, and encodes the
 * JPEG itself: no page's pixels pass through this process. Decoding them here with sharp
 * left about 300 MB of fragmented native heap after a few hundred pages.
 */
const render = (page: number, width: number) =>
  fromVerifiedFile((absolute, signal) =>
    limit(
      () =>
        rendering(`page ${page}`, signal, () =>
          runBounded(
            [
              tools().pdftoppm,
              "-f",
              String(page),
              "-l",
              String(page),
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
              absolute,
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
      signal,
    ),
  );

/**
 * Pages of a PDF on disk, through bounded Poppler processes that read the file through a
 * descriptor opened without following symlinks. Inputs are untrusted user files.
 */
export const PdfRender = {
  parseInfo,
  /** The page count and the sizes of the first pages. */
  info,
  /** Page `page` (from 1) as a JPEG image `width` pixels wide. */
  page: (
    absolute: string,
    page: number,
    width: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> => render(page, width)(absolute, signal),
} as const;
