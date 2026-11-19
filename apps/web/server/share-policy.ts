import { createHash } from "node:crypto";
import type { Share, ShareMode } from "@nimbus/api/drive-store";
import type { ServedBody } from "./file-response";
import type { FileVersion } from "./file-version";
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
 * them. The version is the file's `FileVersion`, read from the open file the view served, not
 * its ETag: content given the old size and modification time is another version. Each proof
 * has a cookie of its own, named by kind, file and version: responses served at once then
 * never overwrite each other's proofs, as they would writing one shared cookie.
 */
const proofScope = (
  kind: "transfer" | "pages",
  share: Pick<Share, "token">,
  relative: string,
  version: FileVersion,
): UnlockScope => ({
  name: `${transferCookies}-${createHash("sha256")
    .update(`${kind}\0${relative}\0${version}`)
    .digest("hex")
    .slice(0, 16)}`,
  path: `/api/share/${share.token}`,
  token: share.token,
  binding: `${kind}:${relative}:${version}`,
});

/**
 * Whether `response`, serving version `version` of the file, continues a counted view this
 * browser already made, so it does not count again. A byte range continues a counted transfer
 * or pages view of the same version: resumed downloads and media seeking. A whole file
 * continues only a pages view, which counted without sending the file, so a visitor can still
 * open or download what they paid one download for; every other whole response counts. Ranges
 * alone (such as `bytes=1-` with byte 0 fetched separately) never make an uncounted copy. A
 * response without a version, such as a ZIP, continues nothing.
 */
function continuesView(
  request: Request,
  response: Response,
  share: Pick<Share, "token">,
  relative: string,
  version: FileVersion | null,
) {
  if (version === null) return false;
  if (response.status === 200)
    return viewedPages(request, share, relative, version);
  return (
    response.status === 206 &&
    continuesTransfer(request, share, relative, version)
  );
}

/** Whether serving `response`, of version `version`, uses up one of the link's downloads. */
function countsAsTransfer(
  request: Request,
  response: Response,
  share: Pick<Share, "token">,
  relative: string,
  version: FileVersion | null,
) {
  return (
    request.method !== "HEAD" &&
    (response.status === 200 || response.status === 206) &&
    !continuesView(request, response, share, relative, version)
  );
}

/**
 * Whether this browser holds a proof of a counted view of version `version` of the file, a
 * transfer or a pages view, so more of it, such as a byte range or a rendered PDF page,
 * continues that view.
 */
function continuesTransfer(
  request: Request,
  share: Pick<Share, "token">,
  relative: string,
  version: FileVersion,
) {
  return (
    UnlockCookie.verify(
      proofScope("transfer", share, relative, version),
      request,
    ) || viewedPages(request, share, relative, version)
  );
}

/** Whether this browser holds the proof of a counted pages view of version `version`. */
function viewedPages(
  request: Request,
  share: Pick<Share, "token">,
  relative: string,
  version: FileVersion,
) {
  return UnlockCookie.verify(
    proofScope("pages", share, relative, version),
    request,
  );
}

/**
 * How a file of this link is sent for `request`: `confirmed` only when it carries a proof that
 * verifies for the version opened (signature, link, file, version and expiry), the only case in
 * which the response can go uncounted. Anything else, such as a cookie that merely looks like
 * a proof, keeps the fast zero-copy path and is counted as usual. The version comes from the
 * file already open for the response; checking it opens nothing and starts nothing.
 */
const servedBody =
  (request: Request, share: Pick<Share, "token">, relative: string) =>
  (version: FileVersion): ServedBody =>
    continuesTransfer(request, share, relative, version) ? "confirmed" : "fast";

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

/** Let later ranges of a counted file response, of version `version`, continue its transfer. */
function allowContinuation(
  request: Request,
  response: Response,
  share: Pick<Share, "token">,
  relative: string,
  version: FileVersion | null,
) {
  if (version !== null)
    issueProof(
      request,
      response,
      proofScope("transfer", share, relative, version),
    );
}

/**
 * Let this browser's counted view of a PDF's pages, version `version`, continue for as long as
 * the proof lasts: more pages, and the whole file by opening or downloading it, without
 * counting again.
 */
function allowPagesView(
  request: Request,
  response: Response,
  share: Pick<Share, "token">,
  relative: string,
  version: FileVersion,
) {
  issueProof(request, response, proofScope("pages", share, relative, version));
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
  servedBody,
  allowContinuation,
  allowPagesView,
  permitsResponse,
} as const;
