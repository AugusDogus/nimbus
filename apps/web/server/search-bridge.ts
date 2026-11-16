import { TRPCError } from "@trpc/server";
import { getDataRoot } from "@nimbus/api/data-root";
import {
  provideSearchService,
  type SearchAnswer,
} from "@nimbus/api/search-service";
import type { SearchInbound, SearchOutbound } from "./search-protocol";

const QUERY_TIMEOUT_MS = 5_000;
/** The first crawl of a large drive takes seconds; usage waits for it. */
const USAGE_TIMEOUT_MS = 120_000;

type Pending =
  | {
      kind: "search";
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
  worker: Worker;
  pending: Map<number, Pending>;
  nextId: number;
};

declare global {
  var __nimbusSearchBridge: BridgeState | undefined;
}

function start(): BridgeState {
  const worker = new Worker(new URL("./search.worker.ts", import.meta.url), {
    type: "module",
  });
  const state: BridgeState = { worker, pending: new Map(), nextId: 1 };
  const send = (message: SearchInbound) => worker.postMessage(message);
  worker.onmessage = (event: MessageEvent<SearchOutbound>) => {
    const message = event.data;
    switch (message.type) {
      case "usage": {
        const pending = state.pending.get(message.id);
        if (!pending) return;
        state.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (pending.kind === "usage") pending.resolve(message.bytes);
        return;
      }
      case "result":
      case "error": {
        const pending = state.pending.get(message.id);
        if (!pending) return;
        state.pending.delete(message.id);
        clearTimeout(pending.timer);
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
        console.info(
          `Nimbus search indexed ${message.entries} items in ${message.elapsedMs} ms (${message.reason})${message.longestPauseMs === null ? "" : `, longest pause ${message.longestPauseMs} ms`}.`,
        );
        return;
      case "failed":
        console.error(
          `Nimbus search index update failed: ${message.message}. Search may miss recent changes until the next reconciliation in 30 minutes.`,
        );
        return;
    }
  };
  worker.onerror = (event) => {
    console.error(
      "Nimbus search worker stopped. It restarts and re-indexes on the next search.",
      event.message,
    );
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "The search index restarted. Your files are unaffected; search again in a moment.",
        }),
      );
    }
    state.pending.clear();
    globalThis.__nimbusSearchBridge = undefined;
  };
  send({ type: "start", root: getDataRoot() });
  return state;
}

const bridge = () => (globalThis.__nimbusSearchBridge ??= start());

/** Register a request the worker answers by id; it fails after `timeoutMs`. */
function track(
  timeoutMs: number,
  timeout: string,
  pending: (timer: ReturnType<typeof setTimeout>) => Pending,
) {
  const state = bridge();
  const id = state.nextId++;
  const timer = setTimeout(() => {
    state.pending
      .get(id)
      ?.reject(new TRPCError({ code: "TIMEOUT", message: timeout }));
    state.pending.delete(id);
  }, timeoutMs);
  state.pending.set(id, pending(timer));
  return { id, worker: state.worker };
}

/** Start the index and register it as the API's search service. */
export function ensureSearchIndex() {
  bridge();
  provideSearchService({
    search: (request) =>
      new Promise<SearchAnswer>((resolve, reject) => {
        const { id, worker } = track(
          QUERY_TIMEOUT_MS,
          "Search took too long to answer. The index may still be starting; try again shortly.",
          (timer) => ({ kind: "search", resolve, reject, timer }),
        );
        const message: SearchInbound = { type: "search", id, request };
        worker.postMessage(message);
      }),
    usage: () =>
      new Promise<number>((resolve, reject) => {
        const { id, worker } = track(
          USAGE_TIMEOUT_MS,
          "Storage usage is not available yet: the drive is still being indexed after startup. Try again in a minute.",
          (timer) => ({ kind: "usage", resolve, reject, timer }),
        );
        const message: SearchInbound = { type: "usage", id };
        worker.postMessage(message);
      }),
  });
}

/** The watcher lost events, so walk the drive again to catch up. */
export function requestSearchRescan() {
  const message: SearchInbound = { type: "rescan" };
  globalThis.__nimbusSearchBridge?.worker.postMessage(message);
}

/** Forward a watcher event so the index re-checks that path on disk. */
export function notifySearchChange(absolutePath: string) {
  const message: SearchInbound = { type: "changed", path: absolutePath };
  globalThis.__nimbusSearchBridge?.worker.postMessage(message);
}
