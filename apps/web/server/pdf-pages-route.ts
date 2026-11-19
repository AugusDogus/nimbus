import path from "node:path";
import type { Access } from "@nimbus/api/access";
import type { DriveStore, Share } from "@nimbus/api/drive-store";
import { DriveFile } from "@nimbus/api/drive-file";
import { safePath } from "@nimbus/api/file-operations";
import { FileKind } from "@/lib/file-kind";
import { PdfPages } from "@/lib/pdf-pages";
import { FileVersion } from "@/server/file-version";
import { httpError } from "@/server/http-error";
import {
  PdfChanged,
  PdfRender,
  PdfRenderFailed,
  PdfRenderUnavailable,
} from "@/server/pdf-render";
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
export type Authorized = {
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

/**
 * What answering a request came to before its file is released: a finished answer, or a
 * counted view, to be settled after, with the pages' response or the error that ended it.
 */
type Answer =
  | { kind: "answered"; response: Response }
  | {
      kind: "counted";
      share: Share;
      version: FileVersion;
      view:
        | { kind: "drawn"; response: Response }
        | { kind: "failed"; error: unknown };
    };

const answered = (response: Response): Answer => ({
  kind: "answered",
  response,
});

/**
 * Close the PDF's descriptor. A failure there loses nothing of the visitor's, so it is logged
 * and not thrown: a counted view must still be settled.
 */
async function release(file: { handle: { close(): Promise<void> } }) {
  try {
    await file.handle.close();
  } catch (error) {
    console.warn(
      "Nimbus could not close a PDF it rendered pages of. The file is unchanged; the descriptor is released when the process ends.",
      error,
    );
  }
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
 * Every refusal comes before Poppler starts, a render slot is taken or a download is counted:
 * the request's own mistakes, access, the file's kind, a public link's proof and download
 * limit, a server without Poppler, and HEAD, which renders nothing and counts nothing. The PDF
 * is opened once; its version, the proof checked, the tags sent and the bytes Poppler reads all
 * come from that one descriptor. A counted view is charged only when it answers with the pages:
 * every other outcome, including a request that leaves, gives the download back.
 */
async function serve(
  request: Request,
  authorize: (url: URL) => Promise<Authorized | Response>,
  store: Pick<DriveStore, "claimDownload" | "refundDownload">,
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
    const answer = async (): Promise<Answer> => {
      const version = FileVersion.of(file.stats);
      const viewed =
        share !== null &&
        SharePolicy.continuesTransfer(request, share, relative, version);
      if (wanted.type === "page") {
        // Pages continue a counted view of this version; they are never a free copy of the file.
        if (share !== null && !viewed)
          return answered(json(403, "Reload the page to view this PDF."));
        const pageTag = `"${version}-${wanted.page}-${wanted.width}"`;
        const headers = {
          ...imageHeaders(pageTag),
          "Content-Type": "image/jpeg",
        };
        if (
          request.method === "HEAD" ||
          request.headers.get("if-none-match") === pageTag
        )
          return answered(
            new Response(null, {
              status: request.method === "HEAD" ? 200 : 304,
              headers,
            }),
          );
        return answered(
          await rendered(request, async () => {
            const body = await PdfRender.page(
              file,
              wanted.page,
              wanted.width,
              request.signal,
            );
            return new Response(new Uint8Array(body), { headers });
          }),
        );
      }
      const counts = share !== null && !viewed;
      if (
        counts &&
        SharePolicy.availability(share, Date.now()).kind === "exhausted"
      )
        return answered(json(404, exhausted));
      if (!PdfRender.available())
        return answered(
          json(
            501,
            "This server cannot render PDF pages. Open the PDF in a new tab or download it instead.",
          ),
        );
      const headers = { "Cache-Control": "no-store", ETag: `"${version}"` };
      if (request.method === "HEAD")
        return answered(
          new Response(null, {
            headers: { ...headers, "Content-Type": "application/json" },
          }),
        );
      const view = () =>
        rendered(request, async () =>
          Response.json(
            {
              ...(await PdfRender.info(file, request.signal)),
              version,
            } satisfies PdfPages,
            { headers },
          ),
        );
      if (!counts) return answered(await view());
      // Counted before rendering, so a refused view never reaches Poppler. Atomic, like a
      // download: of two views for the last one, only one claims it.
      if (!(await store.claimDownload(share.id)))
        return answered(json(404, exhausted));
      try {
        return {
          kind: "counted",
          share,
          version,
          view: { kind: "drawn", response: await view() },
        };
      } catch (error) {
        return {
          kind: "counted",
          share,
          version,
          view: { kind: "failed", error },
        };
      }
    };
    let settled: Answer;
    try {
      settled = await answer();
    } finally {
      await release(file);
    }
    if (settled.kind === "answered") return settled.response;
    // A counted view, settled after every wait, the file's release included. Whether it was
    // delivered is decided here and nothing is awaited after it: a request that left before
    // this line gets its abort and its download back, one still there gets the pages.
    const outcome = settled.view;
    if (
      outcome.kind === "drawn" &&
      outcome.response.ok &&
      !request.signal.aborted
    ) {
      SharePolicy.allowPagesView(
        request,
        outcome.response,
        settled.share,
        relative,
        settled.version,
      );
      return outcome.response;
    }
    await store.refundDownload(settled.share.id);
    if (outcome.kind === "failed") throw outcome.error;
    if (request.signal.aborted)
      throw new DOMException("The request was cancelled.", "AbortError");
    return outcome.response;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      return new Response(null, { status: 499 });
    return httpError(error);
  }
}

/**
 * The PDF pages routes, apart from how a request is authorized and which store counts a public
 * link's downloads, so they run in tests without the server's database.
 */
export const PdfPagesRoute = { serve, json } as const;
