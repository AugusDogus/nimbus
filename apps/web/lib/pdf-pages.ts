import * as z from "zod/mini";

/**
 * A PDF's pages as the server renders them for browsers without a PDF viewer of their own,
 * such as Chrome on Android, which offers to download a framed PDF instead of showing it.
 */
export type PdfPages = {
  /** Pages in the document. */
  count: number;
  /**
   * Width and height in points of each of the first `PdfPages.maxPages` pages, as shown
   * (rotation applied), so their images keep their place while they load.
   */
  sizes: { width: number; height: number }[];
  /** Changes with the file, so page images of an earlier version are never reused. */
  version: string;
};

const schema = z.object({
  count: z.number(),
  sizes: z.array(z.object({ width: z.number(), height: z.number() })),
  version: z.string(),
});

/** Image widths the server renders, in pixels. Fixed so each page has few distinct images. */
const widths = [480, 720, 960, 1280, 1600] as const;

export const PdfPages = {
  /** Pages laid out at most. A longer document shows these and offers the whole file. */
  maxPages: 1000,
  widths,
  isWidth: (value: number): value is (typeof widths)[number] =>
    widths.some((width) => width === value),
  /**
   * The pages endpoint for a PDF's inline preview URL, or null for one it does not know: the
   * drive's `/api/files/pdf`, or `/pdf` under a public link's own endpoint, which receives the
   * link's cookies. Derived here, in the PDF view's own chunk, so pages that may never show a
   * PDF, such as the public share page, load nothing of it at startup.
   */
  endpoint(previewUrl: string): string | null {
    const url = new URL(previewUrl, "http://nimbus.invalid");
    const path = url.searchParams.get("path");
    const share = /^\/api\/share\/([^/]+)$/.exec(url.pathname)?.[1];
    const base =
      url.pathname === "/api/files/download"
        ? "/api/files/pdf"
        : share === undefined
          ? null
          : `/api/share/${share}/pdf`;
    return base === null || path === null
      ? null
      : `${base}?${new URLSearchParams({ path })}`;
  },
  /** The pages endpoint's answer, or an error naming why the pages cannot be shown. */
  async load(url: string, signal?: AbortSignal): Promise<PdfPages> {
    const response = await fetch(url, { cache: "no-store", signal });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = z.object({ error: z.string() }).safeParse(body);
      throw new Error(
        error.success
          ? error.data.error
          : "This PDF could not be shown here. Open it in a new tab or download it.",
      );
    }
    return schema.parse(body);
  },
  /** One page's image at `width` pixels, from the pages endpoint `url`. */
  pageUrl(url: string, pages: PdfPages, page: number, width: number) {
    const params = new URLSearchParams({
      v: pages.version,
      page: String(page),
      width: String(width),
    });
    return `${url}&${params}`;
  },
} as const;
