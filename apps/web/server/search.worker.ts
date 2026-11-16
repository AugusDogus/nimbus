// Runs in a Bun Worker, and starts the scan workers large searches use. It
// may import only packages and the protocol beside it.
import { availableParallelism } from "node:os";
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
import { createScanPool, searchWithPool } from "@nimbus/api/search-scan-pool";
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
/** The search being answered, so a cancel can stop its scan workers. */
let answering: number | null = null;

/**
 * Scan workers for large searches: one fewer than the CPUs this process may
 * use, at most eight, and none with fewer than three. Measured with the
 * search benchmark, unpinned and pinned to four cores. One search uses them
 * at a time, so they never take more than that many cores however many
 * people search.
 */
const scanThreads = Math.min(8, availableParallelism() - 1);
const pool =
  scanThreads >= 2
    ? createScanPool(
        () => new Worker(new URL("./search-scan.worker.ts", import.meta.url)),
        scanThreads,
      )
    : null;

function scheduleSearch() {
  if (searchScheduled || answering !== null || searches.size === 0) return;
  searchScheduled = true;
  setTimeout(() => void runNextSearch(), 0);
}

async function runNextSearch() {
  searchScheduled = false;
  const next = searches.entries().next();
  if (next.done) return;
  const [id, request] = next.value;
  searches.delete(id);
  answering = id;
  try {
    const answer = await searchWithPool(() => live, request, pool);
    // Null: cancelled while its scan ran; nobody waits for it.
    if (answer) post({ type: "result", id, answer: { ...answer, complete } });
  } catch (error) {
    post({
      type: "error",
      id,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    answering = null;
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
      if (answering === message.id) pool?.stop();
      return;
  }
};
