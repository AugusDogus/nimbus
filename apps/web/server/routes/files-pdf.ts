import path from "node:path";
import type { Access } from "@nimbus/api/access";
import type { Share } from "@nimbus/api/drive-store";
import { requireExisting, safePath } from "@nimbus/api/file-operations";
import { FileKind } from "@/lib/file-kind";
import { PdfPages } from "@/lib/pdf-pages";
import { fileETag } from "@/server/file-content";
import { httpDriveStore, httpError, requestAccess } from "@/server/http-files";
import {
  PdfRender,
  PdfRenderFailed,
  PdfRenderUnavailable,
} from "@/server/pdf-render";
import {
  getPublicShare,
  isShareUnlocked,
  sharedTarget,
} from "@/server/public-share";
import { SharePolicy } from "@/server/share-policy";

/**
 * A PDF's pages for browsers without a PDF viewer: `?path=` alone answers with its page count
 * and sizes, and `&page=<n>&width=<px>` with one page as a JPEG image.
 */
type Target = { type: "pages" } | { type: "page"; page: number; width: number };

function target(url: URL): Target | null {
  const page = url.searchParams.get("page");
  const width = url.searchParams.get("width");
  if (page === null && width === null) return { type: "pages" };
  const number = Number(page);
  const pixels = Number(width);
  return Number.isSafeInteger(number) &&
    number >= 1 &&
    number <= PdfPages.maxPages &&
    PdfPages.isWidth(pixels)
    ? { type: "page", page: number, width: pixels }
    : null;
}

/** Who asks: a signed-in reader, or a visitor of a public link, whose views count as its downloads. */
type Authorized = {
  access: Pick<Access, "require">;
  relative: string;
  share: Share | null;
};

const json = (status: number, error: string) =>
  Response.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  );

// Revalidated on every use like thumbnails, so each view is permission checked, while an
// unchanged page costs a 304 without rendering it again.
const imageHeaders = (etag: string) => ({
  ETag: etag,
  "Cache-Control": "private, no-cache",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'",
});

/** The signed-in caller's PDF at `?path=`. */
export async function GET(request: Request) {
  return pdf(request, async (url) => ({
    access: await requestAccess(request),
    relative: (await safePath(url.searchParams.get("path") ?? "")).relative,
    share: null,
  }));
}

/** A PDF at `?path=` inside the public link `token`, under its endpoint for its cookies. */
export async function sharePdf(request: Request, token: string) {
  return pdf(request, async (url) => {
    // A browser continuing a counted view may load pages after the last download is used.
    const { share, access } = await getPublicShare(token, {
      exhausted: "allow",
    });
    if (!isShareUnlocked(share, request))
      return json(401, "Unlock this share with its password to view it.");
    const scoped = await sharedTarget(
      share,
      access,
      url.searchParams.get("path") ?? "",
    );
    return { access: scoped.access, relative: scoped.target.relative, share };
  });
}

const exhausted =
  "This share link has reached its download limit. Ask the owner for a new link.";

async function pdf(
  request: Request,
  authorize: (url: URL) => Promise<Authorized | Response>,
) {
  try {
    const url = new URL(request.url);
    const wanted = target(url);
    if (!wanted)
      return json(
        400,
        `Ask for a page from 1 to ${PdfPages.maxPages} at a width of ${PdfPages.widths.join(", ")} pixels.`,
      );
    const authorized = await authorize(url);
    if (authorized instanceof Response) return authorized;
    const { access, relative, share } = authorized;
    access.require(relative, "read");
    const entry = await requireExisting(relative);
    if (
      !entry.stats.isFile() ||
      FileKind.of(path.basename(entry.absolute)).type !== "pdf"
    )
      return json(415, "Only PDF files have rendered pages.");
    const etag = fileETag(entry.stats);
    const continues =
      share !== null &&
      SharePolicy.continuesTransfer(request, share, relative, etag);
    if (wanted.type === "page") {
      // Pages continue a counted view of this version; they are never a free copy of the file.
      if (share !== null && !continues)
        return json(403, "Reload the page to view this PDF.");
      const pageTag = `${etag.slice(0, -1)}-${wanted.page}-${wanted.width}"`;
      if (request.headers.get("if-none-match") === pageTag)
        return new Response(null, {
          status: 304,
          headers: imageHeaders(pageTag),
        });
      const body = await PdfRender.page(
        entry.absolute,
        wanted.page,
        wanted.width,
        request.signal,
      );
      return new Response(new Uint8Array(body), {
        headers: { ...imageHeaders(pageTag), "Content-Type": "image/jpeg" },
      });
    }
    const pages = await PdfRender.info(entry.absolute, request.signal);
    if (
      share !== null &&
      !continues &&
      (SharePolicy.availability(share, Date.now()).kind === "exhausted" ||
        // Atomic, like a download: of two views for the last one, only one claims it.
        !(await httpDriveStore.claimDownload(share.id)))
    )
      return json(404, exhausted);
    const response = Response.json(
      { ...pages, version: etag.slice(1, -1) } satisfies PdfPages,
      { headers: { "Cache-Control": "no-store", ETag: etag } },
    );
    if (share !== null && !continues)
      SharePolicy.allowContinuation(request, response, share, relative);
    return response;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      return new Response(null, { status: 499 });
    if (error instanceof PdfRenderUnavailable) return json(501, error.message);
    if (error instanceof PdfRenderFailed) {
      console.warn(
        `Nimbus could not render a PDF for ${new URL(request.url).search}. The file is unchanged; the visitor can still open or download it.`,
        error,
      );
      return json(
        422,
        "Nimbus could not render this PDF's pages. It may be damaged, password protected or too complex. Open it in a new tab or download it instead.",
      );
    }
    return httpError(error);
  }
}
