import "server-only";

import { getDataRoot } from "@nimbus/api/data-root";
import { deleteStats, setStats } from "@nimbus/api/stats-cache";

type StatRequest = { type: "stat-request"; path: string };
type WarmUpRequest = { type: "warm-up"; root: string };
type SweepRequest = { type: "sweep"; root: string };

type StatResult = {
  type: "stat-result";
  relativePath: string;
  size: number;
  mtime: number;
};

type StatDeleted = {
  type: "stat-deleted";
  relativePath: string;
};

type WarmUpDone = {
  type: "warm-up-done";
  scanned: number;
  elapsedMs: number;
};

type SweepDone = {
  type: "sweep-done";
  scanned: number;
  elapsedMs: number;
};

type WorkerResponse = StatResult | StatDeleted | WarmUpDone | SweepDone;

type StatsBridgeState = {
  worker: Worker | null;
  sweepTimer: ReturnType<typeof setInterval> | null;
};

const SWEEP_INTERVAL_MS = 5 * 60_000;

const globalForStatsBridge = globalThis as typeof globalThis & {
  __nimbusStatsBridge?: StatsBridgeState;
};

const startWorker = () => {
  if (globalForStatsBridge.__nimbusStatsBridge) {
    return;
  }

  if (typeof Worker === "undefined") {
    console.warn(
      "[nimbus] Stats worker requires Bun Worker. Start the server with Bun runtime to enable background stats.",
    );
    globalForStatsBridge.__nimbusStatsBridge = {
      worker: null,
      sweepTimer: null,
    };
    return;
  }

  const worker = new Worker(new URL("./stats.worker.ts", import.meta.url), {
    type: "module",
  });

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    if (!message || typeof message !== "object") {
      return;
    }
    if (message.type === "stat-result") {
      setStats(message.relativePath, {
        size: message.size,
        mtime: message.mtime,
      });
      return;
    }
    if (message.type === "stat-deleted") {
      deleteStats(message.relativePath);
      return;
    }
    if (message.type === "warm-up-done") {
      console.info(
        `[nimbus] Stats warm-up scanned ${message.scanned} entries in ${message.elapsedMs}ms.`,
      );
      return;
    }
    if (message.type === "sweep-done") {
      console.info(
        `[nimbus] Stats sweep scanned ${message.scanned} entries in ${message.elapsedMs}ms.`,
      );
    }
  };

  const root = getDataRoot();
  const warmUpMessage: WarmUpRequest = { type: "warm-up", root };
  worker.postMessage(warmUpMessage);

  const sweepTimer = setInterval(() => {
    const sweepMessage: SweepRequest = { type: "sweep", root };
    worker.postMessage(sweepMessage);
  }, SWEEP_INTERVAL_MS);

  globalForStatsBridge.__nimbusStatsBridge = { worker, sweepTimer };
};

export const ensureStatsBridge = () => {
  startWorker();
};

export const requestStat = (absolutePath: string) => {
  const bridge = globalForStatsBridge.__nimbusStatsBridge;
  if (!bridge || !bridge.worker) {
    return;
  }
  const message: StatRequest = { type: "stat-request", path: absolutePath };
  bridge.worker.postMessage(message);
};
