import type { Share, ShareMode } from "@nimbus/api/drive-store";

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

/**
 * A transfer counts once, when it includes the first byte. Resumed downloads
 * and media seeking request later ranges and continue the same transfer, while
 * any complete copy still needs at least one counted request.
 */
function countsAsTransfer(method: string, response: Response) {
  if (method === "HEAD") return false;
  if (response.status === 200) return true;
  if (response.status !== 206) return false;
  return /^bytes 0-/.test(response.headers.get("content-range") ?? "");
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
  permitsResponse,
} as const;
