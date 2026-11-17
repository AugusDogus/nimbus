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

/** The proof that this browser already made a counted transfer of one version of a file. */
const continuationScope = (
  share: Pick<Share, "token">,
  relative: string,
  etag: string,
): UnlockScope => ({
  name: "nimbus-transfer",
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

/** Let later ranges of a counted file response continue its transfer without counting. */
function allowContinuation(
  response: Response,
  share: Pick<Share, "token">,
  relative: string,
) {
  const etag = response.headers.get("etag");
  if (etag)
    response.headers.append(
      "Set-Cookie",
      UnlockCookie.issue(continuationScope(share, relative, etag)),
    );
}

/**
 * View-only links offer previews the browser renders inline. This removes the
 * download actions but cannot stop a visitor saving what their browser shows.
 */
function permitsResponse(mode: ShareMode, response: Response) {
  return (
    mode === "download" ||
    (response.headers.get("content-disposition") ?? "").startsWith("inline")
  );
}

export const SharePolicy = {
  availability,
  countsAsTransfer,
  allowContinuation,
  permitsResponse,
} as const;
