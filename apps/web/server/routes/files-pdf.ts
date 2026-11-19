import path from "node:path";
import type { Access } from "@nimbus/api/access";
import type { Share } from "@nimbus/api/drive-store";
import { DriveFile } from "@nimbus/api/drive-file";
import { safePath } from "@nimbus/api/file-operations";
import { FileKind } from "@/lib/file-kind";
import { PdfPages } from "@/lib/pdf-pages";
import { fileETag } from "@/server/file-content";
import { httpDriveStore, httpError, requestAccess } from "@/server/http-files";
import {
  PdfChanged,
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

/**
 * The answer to a render: `render`'s response, or why it could not be drawn, such as a damaged
 * file, a full render queue, or a version changed while it was read. Only a request that left
 * gets no answer.
 */
async function rendered(request: Request, render: () => Promise<Response>) {
  try {
    return await render();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    if (error instanceof PdfRenderUnavailable) return json(501, error.message);
    if (error instanceof PdfChanged) return json(409, error.message);
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

/**
 * Every refusal comes before Poppler starts or a render slot is taken: the request's own
 * mistakes, access, the file's kind, a public link's proof and download limit, and HEAD, which
 * renders nothing and counts nothing. The PDF is opened once; its version, the proof checked,
 * the ETag sent and the bytes Poppler reads all come from that one descriptor.
 */
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
    if (FileKind.of(path.basename(relative)).type !== "pdf")
      return json(415, "Only PDF files have rendered pages.");
    const file = await DriveFile.openFile((await safePath(relative)).absolute);
    try {
      const etag = fileETag(file.stats);
      const viewed =
        share !== null &&
        SharePolicy.continuesTransfer(request, share, relative, etag);
      if (wanted.type === "page") {
        // Pages continue a counted view of this version; they are never a free copy of the file.
        if (share !== null && !viewed)
          return json(403, "Reload the page to view this PDF.");
        const pageTag = `${etag.slice(0, -1)}-${wanted.page}-${wanted.width}"`;
        const headers = {
          ...imageHeaders(pageTag),
          "Content-Type": "image/jpeg",
        };
        if (
          request.method === "HEAD" ||
          request.headers.get("if-none-match") === pageTag
        )
          return new Response(null, {
            status: request.method === "HEAD" ? 200 : 304,
            headers,
          });
        return await rendered(request, async () => {
          const body = await PdfRender.page(
            file,
            wanted.page,
            wanted.width,
            request.signal,
          );
          return new Response(new Uint8Array(body), { headers });
        });
      }
      const counts = share !== null && !viewed;
      if (
        counts &&
        SharePolicy.availability(share, Date.now()).kind === "exhausted"
      )
        return json(404, exhausted);
      const headers = { "Cache-Control": "no-store", ETag: etag };
      if (request.method === "HEAD")
        return new Response(null, {
          headers: { ...headers, "Content-Type": "application/json" },
        });
      // Counted before rendering, so a refused view never reaches Poppler. Atomic, like a
      // download: of two views for the last one, only one claims it.
      if (counts && !(await httpDriveStore.claimDownload(share.id)))
        return json(404, exhausted);
      const response = await rendered(request, async () =>
        Response.json(
          {
            ...(await PdfRender.info(file, request.signal)),
            version: etag.slice(1, -1),
          } satisfies PdfPages,
          { headers },
        ),
      );
      // The view is counted even when its pages cannot be drawn: the proof still lets this
      // browser open or download the PDF without counting again.
      if (counts)
        SharePolicy.allowPagesView(request, response, share, relative, etag);
      return response;
    } finally {
      await file.handle.close();
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      return new Response(null, { status: 499 });
    return httpError(error);
  }
}
