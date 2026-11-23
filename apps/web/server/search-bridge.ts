import { TRPCError } from "@trpc/server";
import { getDataRoot } from "@nimbus/api/data-root";
import {
  provideSearchService,
  type SearchAnswer,
  type SearchService,
} from "@nimbus/api/search-service";
import { RateLimiter, type RateLimitRule } from "./rate-limit";
import type { SearchInbound, SearchOutbound } from "./search-protocol";

/** What the bridge needs from the search worker: a Bun Worker, or a fake in tests. */
export type SearchWorkerPort = {
  postMessage(message: SearchInbound): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<SearchOutbound>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
};

export type SearchBridgeOptions = {
  spawn: () => SearchWorkerPort;
  /** The data root the worker indexes, read when it starts. */
  root: () => string;
  /** How long a search may take before its caller gets an error and the worker drops it. */
  queryTimeoutMs?: number;
  /** The first crawl of a large drive takes seconds; usage waits for it. */
  usageTimeoutMs?: number;
  /** Searches one caller may have waiting or running at once. */
  perCaller?: number;
  /** Searches everyone together may have waiting or running at once. */
  total?: number;
  /** Searches one caller may start: a burst of `limit`, refilled over `windowMs`. */
  rate?: RateLimitRule;
  /** Folders the index could not read, as each crawl or pass finds them. */
  unreadable?: (
    folders: Extract<SearchOutbound, { type: "unreadable" }>["folders"],
  ) => void;
};

type Pending =
  | {
      kind: "search";
      caller: string;
      resolve: (answer: SearchAnswer) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  | {
      kind: "usage";
      resolve: (bytes: number) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    };

type BridgeState = {
  worker: SearchWorkerPort;
  pending: Map<number, Pending>;
};

const cancelled = () =>
  new TRPCError({
    code: "CLIENT_CLOSED_REQUEST",
    message: "The search was cancelled because a newer one replaced it.",
  });

/**
 * The drive index's worker, seen from the server: requests answered by id,
 * each failing after a timeout. Searches are bounded per caller, in flight
 * and over time, and for everyone together, so one caller's burst cannot make
 * everyone's searches wait; the worker takes callers' searches in turn.
 */
export function createSearchBridge(options: SearchBridgeOptions) {
  const queryTimeoutMs = options.queryTimeoutMs ?? 5_000;
  const usageTimeoutMs = options.usageTimeoutMs ?? 120_000;
  const perCaller = options.perCaller ?? 4;
  const total = options.total ?? 64;
  const rate = RateLimiter.create(
    options.rate ?? { limit: 600, windowMs: 60_000 },
  );
  /** The running worker, or null before the first use and after it crashes. */
  let running: BridgeState | null = null;
  let nextId = 1;
  /** Searches in flight per caller. */
  const inFlight = new Map<string, number>();
  let searching = 0;
  /** Settles once the first full index is built, so a supervised server listens only after. */
  const firstIndex = Promise.withResolvers<void>();
  /** Set once the server stopped searching for good, as a draining server does. */
  let stopped = false;

  /** Forget a pending request: it was answered, failed, timed out or cancelled. */
  const settle = (state: BridgeState, id: number) => {
    const pending = state.pending.get(id);
    if (!pending) return null;
    state.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.kind === "search") {
      searching--;
      const count = (inFlight.get(pending.caller) ?? 1) - 1;
      if (count > 0) inFlight.set(pending.caller, count);
      else inFlight.delete(pending.caller);
    }
    return pending;
  };

  function start(): BridgeState {
    const worker = options.spawn();
    const state: BridgeState = { worker, pending: new Map() };
    worker.onmessage = (event) => {
      const message = event.data;
      switch (message.type) {
        case "usage": {
          const pending = settle(state, message.id);
          if (pending?.kind === "usage") pending.resolve(message.bytes);
          return;
        }
        case "result":
        case "error": {
          const pending = settle(state, message.id);
          if (!pending) return;
          if (message.type === "result") {
            if (pending.kind === "search") pending.resolve(message.answer);
          } else
            pending.reject(
              new TRPCError({
                code: "INTERNAL_SERVER_ERROR",
                message: `Search failed inside the index: ${message.message}. Your files are unaffected; try again.`,
              }),
            );
          return;
        }
        case "indexed":
          firstIndex.resolve();
          console.info(
            `Nimbus search indexed ${message.entries} items in ${message.elapsedMs} ms (${message.reason})${message.longestPauseMs === null ? "" : `, longest pause ${message.longestPauseMs} ms`}.`,
          );
          return;
        case "failed":
          console.error(
            `Nimbus search index update failed: ${message.message}. Search may miss recent changes until the next reconciliation.`,
          );
          return;
        case "unreadable":
          options.unreadable?.(message.folders);
          return;
      }
    };
    worker.onerror = (event) => {
      console.error(
        "Nimbus search worker stopped. It restarts and re-indexes on the next search.",
        event.message,
      );
      for (const id of [...state.pending.keys()])
        settle(state, id)?.reject(
          new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message:
              "The search index restarted. Your files are unaffected; search again in a moment.",
          }),
        );
      // Bun closes a worker on an uncaught error, with the scan workers it
      // started; end it here too, so a failure that leaves it running never
      // keeps a second index alongside the next worker's.
      worker.terminate();
      running = null;
    };
    worker.postMessage({ type: "start", root: options.root() });
    return state;
  }

  const bridge = () => {
    if (stopped)
      throw new TRPCError({
        code: "SERVICE_UNAVAILABLE",
        message:
          "This Nimbus server is handing over to a newer one and no longer searches. Search again.",
      });
    return (running ??= start());
  };

  /** Register a request the worker answers by id; it fails after `timeoutMs`. */
  function track(
    timeoutMs: number,
    timeout: string,
    pending: (timer: ReturnType<typeof setTimeout>) => Pending,
  ) {
    const state = bridge();
    const id = nextId++;
    const timer = setTimeout(() => {
      const timedOut = settle(state, id);
      if (!timedOut) return;
      timedOut.reject(new TRPCError({ code: "TIMEOUT", message: timeout }));
      // Nobody waits for it now: drop it if it has not run yet.
      if (timedOut.kind === "search")
        state.worker.postMessage({ type: "cancel", id });
    }, timeoutMs);
    const entry = pending(timer);
    state.pending.set(id, entry);
    if (entry.kind === "search") {
      searching++;
      inFlight.set(entry.caller, (inFlight.get(entry.caller) ?? 0) + 1);
    }
    return { id, state };
  }

  /** Why a caller's search cannot start now, or null when it can. */
  function refusal(caller: string) {
    if ((inFlight.get(caller) ?? 0) >= perCaller)
      return `You already have ${perCaller} searches running. Nothing was searched; wait for one to finish and try again.`;
    if (searching >= total)
      return "Search is busy with other people's searches right now. Nothing was searched; try again in a few seconds.";
    // Counted before any work, so refused searches never reach the worker.
    const decision = rate.consume(caller);
    return decision.allowed
      ? null
      : `Too many searches. Nothing was searched; try again in ${RateLimiter.seconds(decision.retryAfterSeconds)}.`;
  }

  const service: SearchService = {
    search: (request, { caller, signal }) =>
      new Promise<SearchAnswer>((resolve, reject) => {
        if (signal?.aborted) {
          reject(cancelled());
          return;
        }
        const refused = refusal(caller);
        if (refused !== null) {
          reject(
            new TRPCError({ code: "TOO_MANY_REQUESTS", message: refused }),
          );
          return;
        }
        const { id, state } = track(
          queryTimeoutMs,
          "Search took too long to answer. The index may still be starting; try again shortly.",
          (timer) => ({ kind: "search", caller, resolve, reject, timer }),
        );
        state.worker.postMessage({
          type: "search",
          id,
          caller,
          // Past this, the worker stops the search even if it has started.
          request: { ...request, deadline: Date.now() + queryTimeoutMs },
        });
        signal?.addEventListener(
          "abort",
          () => {
            const pending = settle(state, id);
            if (!pending) return;
            pending.reject(cancelled());
            state.worker.postMessage({ type: "cancel", id });
          },
          { once: true },
        );
      }),
    usage: () =>
      new Promise<number>((resolve, reject) => {
        const { id, state } = track(
          usageTimeoutMs,
          "Storage usage is not available yet: the drive is still being indexed after startup. Try again in a minute.",
          (timer) => ({ kind: "usage", resolve, reject, timer }),
        );
        state.worker.postMessage({ type: "usage", id });
      }),
  };

  return {
    service,
    /** Start the worker now, so it indexes before the first search. */
    start: () => void bridge(),
    /** Resolves once the index has been built for the first time. */
    indexed: firstIndex.promise,
    /** End the index and its worker for good, freeing their memory; searches then fail. */
    stop() {
      stopped = true;
      const state = running;
      running = null;
      if (!state) return;
      for (const id of [...state.pending.keys()])
        settle(state, id)?.reject(
          new TRPCError({
            code: "SERVICE_UNAVAILABLE",
            message:
              "This Nimbus server is handing over to a newer one. Search again.",
          }),
        );
      state.worker.terminate();
    },
    /** The watcher lost events, so walk the drive again to catch up. */
    rescan: () => running?.worker.postMessage({ type: "rescan" }),
    /** Forward a watcher event so the index re-checks that path on disk. */
    changed: (absolutePath: string) =>
      running?.worker.postMessage({ type: "changed", path: absolutePath }),
  };
}

let unreadableListener: NonNullable<
  SearchBridgeOptions["unreadable"]
> = () => {};

const server = createSearchBridge({
  spawn: () =>
    new Worker(new URL("./search.worker.ts", import.meta.url), {
      type: "module",
    }),
  root: getDataRoot,
  unreadable: (folders) => unreadableListener(folders),
});

/**
 * Start the index and register it as the API's search service. `onUnreadable` hears of
 * folders it could not read.
 */
export function ensureSearchIndex(
  onUnreadable: NonNullable<SearchBridgeOptions["unreadable"]> = () => {},
) {
  unreadableListener = onUnreadable;
  server.start();
  provideSearchService(server.service);
}

/** Resolves once the drive index has been built for the first time since startup. */
export const searchIndexed = () => server.indexed;

/** End the drive index for good, as a draining server does. */
export const stopSearchIndex = () => server.stop();

/** The watcher lost events, so walk the drive again to catch up. */
export function requestSearchRescan() {
  server.rescan();
}

/** Forward a watcher event so the index re-checks that path on disk. */
export function notifySearchChange(absolutePath: string) {
  server.changed(absolutePath);
}
