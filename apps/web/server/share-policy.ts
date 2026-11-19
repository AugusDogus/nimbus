import { createHash } from "node:crypto";
import type { Share, ShareMode } from "@nimbus/api/drive-store";
import { UnlockCookie, type UnlockScope } from "./unlock-cookie";

export type ShareAvailability =
  | { kind: "available" }
  | { kind: "expired" }
  | { kind: "exhausted" };

function availability(
  share: Pick<Share, "expiresAt" | "maxDownloads" | "downloadCount">,
  now: number,
): ShareAvailability {
  if (share.expiresAt !== null && share.expiresAt <= now)
    return { kind: "expired" };
  if (share.maxDownloads !== null && share.downloadCount >= share.maxDownloads)
    return { kind: "exhausted" };
  return { kind: "available" };
}

/** Prefix of the cookies proving this browser's counted transfers, one cookie per transfer. */
const transferCookies = "nimbus-transfer";

/**
 * The proof that this browser already made a counted view of one version of a file: a
 * `transfer` of its bytes, or a `pages` view of a PDF's rendered pages, which sent none of
 * them. Each has a cookie of its own, named by the kind, file and version: responses served at
 * once then never overwrite each other's proofs, as they would writing one shared cookie.
 */
const proofScope = (
  kind: "transfer" | "pages",
  share: Pick<Share, "token">,
  relative: string,
  etag: string,
): UnlockScope => ({
  name: `${transferCookies}-${createHash("sha256")
    .update(
      kind === "transfer"
        ? `${relative}\0${etag}`
        : `pages\0${relative}\0${etag}`,
    )
    .digest("hex")
    .slice(0, 16)}`,
  path: `/api/share/${share.token}`,
  token: share.token,
  binding: `${kind}:${relative}:${etag}`,
});

/**
 * Whether `response` continues a counted view this browser already made, so it does not count
 * again. A byte range continues a counted transfer or pages view of the same version: resumed
 * downloads and media seeking. A whole file continues only a pages view, which counted without
 * sending the file, so a visitor can still open or download what they paid one download for;
 * every other whole response counts. Ranges alone (such as `bytes=1-` with byte 0 fetched
 * separately) never make an uncounted copy.
 */
function continuesView(
  request: Request,
  response: Response,
  share: Pick<Share, "token">,
  relative: string,
) {
  const etag = response.headers.get("etag");
  if (etag === null) return false;
  if (response.status === 200)
    return viewedPages(request, share, relative, etag);
  return (
    response.status === 206 && continuesTransfer(request, share, relative, etag)
  );
}

/** Whether serving `response` uses up one of the link's downloads. */
function countsAsTransfer(
  request: Request,
  response: Response,
  share: Pick<Share, "token">,
  relative: string,
) {
  return (
    request.method !== "HEAD" &&
    (response.status === 200 || response.status === 206) &&
    !continuesView(request, response, share, relative)
  );
}

/**
 * Whether this browser holds a proof of a counted view of version `etag` of the file, a
 * transfer or a pages view, so more of it, such as a byte range or a rendered PDF page,
 * continues that view.
 */
function continuesTransfer(
  request: Request,
  share: Pick<Share, "token">,
  relative: string,
  etag: string,
) {
  return (
    UnlockCookie.verify(
      proofScope("transfer", share, relative, etag),
      request,
    ) || viewedPages(request, share, relative, etag)
  );
}

/** Whether this browser holds the proof of a counted pages view of version `etag`. */
function viewedPages(
  request: Request,
  share: Pick<Share, "token">,
  relative: string,
  etag: string,
) {
  return UnlockCookie.verify(
    proofScope("pages", share, relative, etag),
    request,
  );
}

/** Transfers one browser can continue at once, across a folder link's files. */
const continuableTransfers = 16;

/**
 * Set the proof `scope` on `response`. The browser's oldest proofs on this link beyond
 * `continuableTransfers` are removed, so the cookies it sends stay few.
 */
function issueProof(request: Request, response: Response, scope: UnlockScope) {
  response.headers.append("Set-Cookie", UnlockCookie.issue(scope));
  const others = UnlockCookie.family(transferCookies, request).filter(
    (cookie) => cookie.name !== scope.name,
  );
  for (const old of others.slice(
    0,
    Math.max(0, others.length - (continuableTransfers - 1)),
  ))
    response.headers.append(
      "Set-Cookie",
      UnlockCookie.expire(old.name, scope.path),
    );
}

/** Let later ranges of a counted file response continue its transfer without counting. */
function allowContinuation(
  request: Request,
  response: Response,
  share: Pick<Share, "token">,
  relative: string,
) {
  const etag = response.headers.get("etag");
  if (etag)
    issueProof(
      request,
      response,
      proofScope("transfer", share, relative, etag),
    );
}

/**
 * Let this browser's counted view of a PDF's pages, version `etag`, continue for as long as the
 * proof lasts: more pages, and the whole file by opening or downloading it, without counting
 * again.
 */
function allowPagesView(
  request: Request,
  response: Response,
  share: Pick<Share, "token">,
  relative: string,
  etag: string,
) {
  issueProof(request, response, proofScope("pages", share, relative, etag));
}

/**
 * View-only links offer previews the browser renders inline. This removes the
 * download actions but cannot stop a visitor saving what their browser shows.
 */
function permitsResponse(mode: ShareMode, response: Response) {
  return (
    mode === "download" ||
    // No content is sent, such as a 304 revalidating a preview the browser already has.
    (response.status !== 200 && response.status !== 206) ||
    (response.headers.get("content-disposition") ?? "").startsWith("inline")
  );
}

export const SharePolicy = {
  availability,
  countsAsTransfer,
  continuesView,
  continuesTransfer,
  allowContinuation,
  allowPagesView,
  permitsResponse,
} as const;
