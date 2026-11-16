// Runs in a Bun Worker. Next copies this file without bundling it, so it may
// import only packages, never relative or "@/" paths.
import {
  applyChange,
  crawl,
  reconcile,
  type Serialize,
} from "@nimbus/api/search-crawler";
import {
  createSearchIndex,
  type SearchIndex,
  type SearchRequest,
} from "@nimbus/api/search-index";
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
/** Storage usage requests wait for the first complete crawl, then read the root total. */
let markIndexed = () => {};
const indexed = new Promise<void>((resolve) => {
  markIndexed = resolve;
});

const post = (message: SearchOutbound) => self.postMessage(message);

/** Run index work in turn with watcher changes, so neither sees the other half done. */
const serialize: Serialize = (work) => {
  const result = changes.then(work);
  changes = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

let reconciling = false;
let reconcileAgain = false;

/**
 * Catch up with the disk in place: the index keeps answering searches from its
 * current contents while each folder is compared with a fresh listing. Only
 * when freed id slots outnumber live entries, after heavy churn, is a second
 * index built instead, which also reclaims them.
 */
async function reconcileLive() {
  if (queued) {
    // The startup crawl replays changes itself; check again once it is done.
    reconcileAgain = true;
    return;
  }
  if (reconciling) {
    reconcileAgain = true;
    return;
  }
  reconciling = true;
  try {
    do {
      reconcileAgain = false;
      if (live.freedIds > Math.max(live.size, 1 << 16)) {
        await rebuild("reconcile");
        continue;
      }
      const started = performance.now();
      const pass = await reconcile(live, root, serialize);
      await serialize(async () => live.maybeCompact());
      post({
        type: "indexed",
        reason: "reconcile",
        entries: live.size,
        elapsedMs: Math.round(performance.now() - started),
        longestPauseMs: Math.round(pass.longestSliceMs),
      });
      if (pass.unreadable)
        report(
          new Error(
            `${pass.unreadable} folders could not be read, so search and storage usage keep what was last seen in them. Check the permissions of the data root.`,
          ),
        );
    } while (reconcileAgain);
  } finally {
    reconciling = false;
  }
}

async function rebuild(reason: "startup" | "reconcile") {
  if (queued) return;
  queued = [];
  overflowed = false;
  const started = performance.now();
  // At startup the live index fills in place so early searches see partial results.
  const fresh =
    reason === "startup"
      ? live
      : // Room for every entry plus the root, so a same-size tree never doubles the arrays.
        createSearchIndex(Math.max(1 << 16, live.size + 1));
  building = fresh;
  try {
    await crawl(fresh, root);
    for (let i = 0; i < queued.length; i++)
      await applyChange(fresh, root, queued[i]);
    live = fresh;
    complete = true;
    markIndexed();
    post({
      type: "indexed",
      reason,
      entries: fresh.size,
      elapsedMs: Math.round(performance.now() - started),
      longestPauseMs: null,
    });
  } finally {
    building = null;
    queued = null;
  }
  if (overflowed || reconcileAgain) void reconcileLive().catch(report);
}

/**
 * Searches waiting to run, oldest first. One runs per task, so a cancel that
 * arrives meanwhile (the user typed on) removes its search before it runs,
 * and many users' searches take turns instead of piling up.
 */
const searches = new Map<number, SearchRequest>();
let searchScheduled = false;

function scheduleSearch() {
  if (searchScheduled || searches.size === 0) return;
  searchScheduled = true;
  setTimeout(runNextSearch, 0);
}

function runNextSearch() {
  searchScheduled = false;
  const next = searches.entries().next();
  if (next.done) return;
  const [id, request] = next.value;
  searches.delete(id);
  try {
    post({
      type: "result",
      id,
      answer: { ...live.search(request), complete },
    });
  } catch (error) {
    post({
      type: "error",
      id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  scheduleSearch();
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
      setInterval(() => void reconcileLive().catch(report), RECONCILE_MS);
      return;
    case "changed":
      if (queued) {
        if (queued.length < MAX_QUEUED) queued.push(message.path);
        else overflowed = true;
      }
      // A startup crawl owns the live index; its queue replays this change.
      if (building === live) return;
      void serialize(() => applyChange(live, root, message.path)).catch(report);
      return;
    case "rescan":
      void reconcileLive().catch(report);
      return;
    case "usage":
      void indexed.then(() =>
        post({ type: "usage", id: message.id, bytes: live.bytesAt("") ?? 0 }),
      );
      return;
    case "search":
      searches.set(message.id, message.request);
      scheduleSearch();
      return;
    case "cancel":
      searches.delete(message.id);
      return;
  }
};
