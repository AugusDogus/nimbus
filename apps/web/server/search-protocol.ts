import type { SearchRequest } from "@nimbus/api/search-index";
import type { SearchAnswer } from "@nimbus/api/search-service";

/** Messages to the search worker. */
export type SearchInbound =
  | { type: "start"; root: string }
  | { type: "changed"; path: string }
  /** `caller` (a user id) is who waits for it; the worker serves callers in turn. */
  | { type: "search"; id: number; caller: string; request: SearchRequest }
  /** Nobody waits for this search any more: drop it if it has not run yet. */
  | { type: "cancel"; id: number }
  | { type: "usage"; id: number }
  /** The watcher lost events: walk the drive again. */
  | { type: "rescan" };

/** Messages from the search worker. */
export type SearchOutbound =
  | { type: "result"; id: number; answer: SearchAnswer }
  | { type: "usage"; id: number; bytes: number }
  | { type: "error"; id: number; message: string }
  | {
      type: "indexed";
      reason: "startup" | "reconcile";
      entries: number;
      elapsedMs: number;
      /** Longest single hold on the index during an in-place pass; null for full crawls. */
      longestPauseMs: number | null;
    }
  | { type: "failed"; message: string }
  /** Folders a crawl or pass could not list, by absolute path, with the error code why. */
  | {
      type: "unreadable";
      folders: { path: string; code: string | null }[];
    };

/**
 * How often the search index is compared with the disk, catching anything the file watcher
 * missed, and folders it could not read are checked again: `NIMBUS_RECONCILE_INTERVAL_MS`,
 * at least one second, by default 30 minutes. Invalid values use the default.
 */
export function reconcileIntervalMs() {
  const configured = Number(process.env.NIMBUS_RECONCILE_INTERVAL_MS ?? "");
  return Number.isFinite(configured) && configured >= 1000
    ? configured
    : 30 * 60_000;
}
