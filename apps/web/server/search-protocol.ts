import type { SearchRequest } from "@nimbus/api/search-index";
import type { SearchAnswer } from "@nimbus/api/search-service";

/** Messages to the search worker. */
export type SearchInbound =
  | { type: "start"; root: string }
  | { type: "changed"; path: string }
  | { type: "search"; id: number; request: SearchRequest };

/** Messages from the search worker. */
export type SearchOutbound =
  | { type: "result"; id: number; answer: SearchAnswer }
  | { type: "error"; id: number; message: string }
  | {
      type: "indexed";
      reason: "startup" | "reconcile";
      entries: number;
      elapsedMs: number;
    }
  | { type: "failed"; message: string };
