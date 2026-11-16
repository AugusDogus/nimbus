/**
 * Scan workers for large indexes: each scans its share of a layout's slots
 * (search-scan.ts) in parallel, reading the layout in place from shared
 * memory. A layout is never changed after compaction except for its `dead`
 * marks, which only grow, so a worker can scan while the index changes;
 * the caller compares the index's change counter before and after and
 * answers again on its own thread when it moved.
 *
 * One scan runs at a time, so many users' searches take turns on the same few
 * threads instead of multiplying them. A newer scan, or `stop`, ends the
 * running one within about a thousand matches per worker.
 */
import type { SearchIndex, SearchRequest, SearchResult } from "./search-index";
import {
  splitRanges,
  type CompactRanks,
  type ScanPlan,
  type SearchLayout,
} from "./search-scan";

/** Messages to a scan worker. */
export type ScanWorkerInbound =
  | { type: "layout"; generation: number; layout: SearchLayout }
  | { type: "drop"; generation: number }
  | {
      type: "scan";
      job: number;
      generation: number;
      plan: ScanPlan;
      limit: number;
      /** Int32 slot 0 holds the job that may run; anything else stops it. */
      control: Int32Array;
    };

/** Messages from a scan worker. */
export type ScanWorkerOutbound =
  | { type: "ranks"; job: number; ranks: CompactRanks }
  | { type: "stopped"; job: number }
  | { type: "failed"; job: number; message: string };

export type ScanOutcome =
  | { ok: true; ranks: CompactRanks }
  | { ok: false; reason: "stopped" }
  | { ok: false; reason: "failed"; message: string };

/** A layout's arrays live on shared memory, so workers can read them in place. */
export const isShared = (layout: SearchLayout) =>
  layout.folded.buffer instanceof SharedArrayBuffer &&
  layout.dead.buffer instanceof SharedArrayBuffer;

/** Name bytes a scan would read, to choose between this thread and the pool. */
export function scanBytes(layout: SearchLayout, plan: ScanPlan) {
  let bytes = 0;
  for (const range of plan.ranges)
    bytes +=
      (layout.foldedStarts[range.end] ?? 0) -
      (layout.foldedStarts[range.first] ?? 0);
  return bytes * Math.max(1, plan.terms.length + 1);
}

type Running = {
  job: number;
  waiting: number;
  parts: CompactRanks[];
  limit: number;
  resolve: (outcome: ScanOutcome) => void;
};

/** Merge the workers' best ranks into one sorted list of at most `limit`. */
function merge(parts: CompactRanks[], limit: number): CompactRanks {
  let total = 0;
  let count = 0;
  for (const part of parts) {
    total += part.total;
    count += part.best.length;
  }
  const best = new Float64Array(count);
  let at = 0;
  for (const part of parts) {
    best.set(part.best, at);
    at += part.best.length;
  }
  best.sort();
  return { best: best.subarray(0, limit), total };
}

export function createScanPool(spawn: () => Worker, size: number) {
  const workers = Array.from({ length: size }, spawn);
  const control = new Int32Array(new SharedArrayBuffer(4));
  const generations = new WeakMap<SearchLayout, number>();
  let published: SearchLayout | null = null;
  let nextGeneration = 1;
  let nextJob = 1;
  let running: Running | null = null;
  let broken: string | null = null;

  const post = (worker: Worker, message: ScanWorkerInbound) =>
    worker.postMessage(message);

  const settle = (outcome: ScanOutcome) => {
    const job = running;
    running = null;
    job?.resolve(outcome);
  };

  for (const worker of workers) {
    worker.onmessage = (event: MessageEvent<ScanWorkerOutbound>) => {
      const message = event.data;
      const job = running;
      if (!job || message.job !== job.job) return;
      if (message.type === "failed") {
        settle({ ok: false, reason: "failed", message: message.message });
        return;
      }
      if (message.type === "stopped") {
        settle({ ok: false, reason: "stopped" });
        return;
      }
      job.parts.push(message.ranks);
      if (--job.waiting === 0)
        settle({ ok: true, ranks: merge(job.parts, job.limit) });
    };
    worker.onerror = (event) => {
      broken = `A search scan worker stopped: ${event.message}`;
      settle({ ok: false, reason: "failed", message: broken });
    };
  }

  /** The generation workers know `layout` by, sending it to them first if needed. */
  const publish = (layout: SearchLayout) => {
    const known = generations.get(layout);
    if (known !== undefined && published === layout) return known;
    const generation = known ?? nextGeneration++;
    generations.set(layout, generation);
    const previous = published ? generations.get(published) : undefined;
    for (const worker of workers) {
      post(worker, { type: "layout", generation, layout });
      if (previous !== undefined && previous !== generation)
        post(worker, { type: "drop", generation: previous });
    }
    published = layout;
    return generation;
  };

  return {
    size,

    /**
     * Scan `plan` over `layout` across the workers, keeping the best `limit`
     * ranks. Stops a scan still running. Fails, as a value, if a worker
     * stopped; the caller scans on its own thread instead.
     */
    scan(
      layout: SearchLayout,
      plan: ScanPlan,
      limit: number,
    ): Promise<ScanOutcome> {
      if (broken !== null)
        return Promise.resolve({
          ok: false,
          reason: "failed",
          message: broken,
        });
      if (!isShared(layout))
        return Promise.resolve({
          ok: false,
          reason: "failed",
          message:
            "The index layout is not on shared memory, so scan workers cannot read it.",
        });
      settle({ ok: false, reason: "stopped" });
      const generation = publish(layout);
      const groups = splitRanges(layout, plan.ranges, workers.length);
      const job = nextJob++;
      Atomics.store(control, 0, job);
      return new Promise<ScanOutcome>((resolve) => {
        if (groups.length === 0) {
          resolve({ ok: true, ranks: { best: new Float64Array(0), total: 0 } });
          return;
        }
        running = {
          job,
          waiting: groups.length,
          parts: [],
          limit,
          resolve,
        };
        groups.forEach((ranges, index) => {
          const worker = workers[index];
          if (worker)
            post(worker, {
              type: "scan",
              job,
              generation,
              plan: { ...plan, ranges },
              limit,
              control,
            });
        });
      });
    },

    /** End the running scan, if any; its promise resolves as stopped. */
    stop() {
      Atomics.store(control, 0, 0);
      settle({ ok: false, reason: "stopped" });
    },

    close() {
      this.stop();
      for (const worker of workers) worker.terminate();
    },
  };
}

export type ScanPool = ReturnType<typeof createScanPool>;

/**
 * Below this many name bytes to read, a scan on the calling thread beats
 * handing it to workers. Measured with the search benchmark; see its report.
 */
export const POOL_MIN_BYTES = 4 * 1024 * 1024;

/**
 * Answer `request` from `index`, scanning its compacted names in `pool` when
 * the scan is large enough. If the index changed (or was replaced) while workers scanned, the
 * answer is computed again here from its current state, so results never mix
 * two versions of the tree. Null when the scan was stopped for a newer one.
 */
export async function searchWithPool(
  /** The index to search; read again after the scan, as a rebuild may replace it. */
  current: () => SearchIndex,
  request: SearchRequest,
  pool: ScanPool | null,
  minBytes = POOL_MIN_BYTES,
): Promise<SearchResult | null> {
  const index = current();
  const before = index.changes;
  let prepared = index.prepareSearch(request);
  while (!prepared.done) {
    const { layout, plan, limit } = prepared;
    if (!pool || scanBytes(layout, plan) < minBytes || !isShared(layout)) {
      prepared = prepared.finish(index.scanHere(layout, plan, limit));
      continue;
    }
    const outcome = await pool.scan(layout, plan, limit);
    if (!outcome.ok && outcome.reason === "stopped") return null;
    const now = current();
    if (!outcome.ok || now !== index || index.changes !== before)
      return now.search(request);
    prepared = prepared.finish(outcome.ranks);
  }
  return prepared.done;
}
