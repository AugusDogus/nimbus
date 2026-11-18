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
 * The proof that this browser already made a counted transfer of one version of a file. Each
 * transfer has a cookie of its own, named by the file and version: responses served at once
 * then never overwrite each other's proofs, as they would writing one shared cookie.
 */
const continuationScope = (
  share: Pick<Share, "token">,
  relative: string,
  etag: string,
): UnlockScope => ({
  name: `${transferCookies}-${createHash("sha256")
    .update(`${relative}\0${etag}`)
    .digest("hex")
    .slice(0, 16)}`,
  path: `/api/share/${share.token}`,
  token: share.token,
  binding: `transfer:${relative}:${etag}`,
});

/**
 * Whether serving `response` uses up one of the link's downloads. Every full
 * response counts. A byte range counts too, unless the browser holds the
 * cookie a counted transfer of the same file version set: resumed downloads
 * and media seeking then continue that transfer, while ranges alone (such as
 * `bytes=1-` with byte 0 fetched separately) can never make an uncounted copy.
 */
function countsAsTransfer(
  request: Request,
  response: Response,
  share: Pick<Share, "token">,
  relative: string,
) {
  if (request.method === "HEAD") return false;
  if (response.status === 200) return true;
  if (response.status !== 206) return false;
  const etag = response.headers.get("etag");
  return !(
    etag &&
    UnlockCookie.verify(continuationScope(share, relative, etag), request)
  );
}

/** Transfers one browser can continue at once, across a folder link's files. */
const continuableTransfers = 16;

/**
 * Let later ranges of a counted file response continue its transfer without counting. The
 * browser's oldest transfer cookies on this link beyond `continuableTransfers` are removed, so
 * the cookies it sends stay few.
 */
function allowContinuation(
  request: Request,
  response: Response,
  share: Pick<Share, "token">,
  relative: string,
) {
  const etag = response.headers.get("etag");
  if (!etag) return;
  const scope = continuationScope(share, relative, etag);
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
  allowContinuation,
  permitsResponse,
} as const;
