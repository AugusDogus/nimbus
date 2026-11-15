// Runs in a Bun Worker. Next copies this file without bundling it, so it may
// import only packages, never relative or "@/" paths.
import { applyChange, crawl } from "@nimbus/api/search-crawler";
import { createSearchIndex, type SearchIndex } from "@nimbus/api/search-index";
import type { SearchInbound, SearchOutbound } from "./search-protocol";

declare const self: Worker;

/** Catches anything the watcher missed: dropped events, edits while stopped. */
const RECONCILE_MS = 30 * 60_000;
/** Beyond this many changes during a crawl, crawl again instead of replaying. */
const MAX_QUEUED = 100_000;

let root = "";
let live: SearchIndex = createSearchIndex(1 << 16);
let complete = false;
let queued: string[] | null = null;
let overflowed = false;
/** The index a crawl is filling; it alone mutates it until the queue replays. */
let building: SearchIndex | null = null;
let changes = Promise.resolve();

const post = (message: SearchOutbound) => self.postMessage(message);

async function rebuild(reason: "startup" | "reconcile") {
  if (queued) return;
  queued = [];
  overflowed = false;
  const started = performance.now();
  // At startup the live index fills in place so early searches see partial results.
  const fresh =
    reason === "startup"
      ? live
      : createSearchIndex(Math.max(1 << 16, live.size));
  building = fresh;
  try {
    await crawl(fresh, root);
    for (let i = 0; i < queued.length; i++)
      await applyChange(fresh, root, queued[i]);
    live = fresh;
    complete = true;
    post({
      type: "indexed",
      reason,
      entries: fresh.size,
      elapsedMs: Math.round(performance.now() - started),
    });
  } finally {
    building = null;
    queued = null;
  }
  if (overflowed) void rebuild("reconcile").catch(report);
}

function report(error: unknown) {
  post({
    type: "failed",
    message: error instanceof Error ? error.message : String(error),
  });
}

self.onmessage = (event: MessageEvent<SearchInbound>) => {
  const message = event.data;
  switch (message.type) {
    case "start":
      root = message.root;
      void rebuild("startup").catch(report);
      setInterval(() => void rebuild("reconcile").catch(report), RECONCILE_MS);
      return;
    case "changed":
      if (queued) {
        if (queued.length < MAX_QUEUED) queued.push(message.path);
        else overflowed = true;
      }
      // A startup crawl owns the live index; its queue replays this change.
      if (building === live) return;
      changes = changes
        .then(() => applyChange(live, root, message.path))
        .catch(report);
      return;
    case "search":
      try {
        post({
          type: "result",
          id: message.id,
          answer: { ...live.search(message.request), complete },
        });
      } catch (error) {
        post({
          type: "error",
          id: message.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
  }
};
