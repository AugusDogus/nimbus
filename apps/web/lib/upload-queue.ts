/** What to do when an uploaded name already exists. Mirrors the upload route's metadata. */
export type UploadConflict = "keep-both" | "replace";

export type UploadRequest = {
  file: File;
  filename: string;
  /** Existing folder the upload targets. */
  targetPath: string;
  /** Folders to recreate under `targetPath`, for folder uploads. */
  folder: string;
  conflict: UploadConflict;
  userId: string;
};

export type UploadStatus =
  | { kind: "queued" }
  | { kind: "uploading"; sent: number }
  | { kind: "done" }
  | { kind: "failed"; message: string }
  | { kind: "cancelled" };

export type UploadItem = {
  id: number;
  request: UploadRequest;
  status: UploadStatus;
};

export type UploadSummary = {
  total: number;
  queued: number;
  active: number;
  done: number;
  failed: number;
  cancelled: number;
  sentBytes: number;
  totalBytes: number;
};

export type UploadSnapshot = {
  items: readonly UploadItem[];
  summary: UploadSummary;
};

type TransportEvents = {
  progress(sent: number): void;
  success(): void;
  failure(message: string): void;
};
/** Starts one upload. `abort` stops it and discards what the server received. */
export type UploadTransport = (
  request: UploadRequest,
  events: TransportEvents,
) => { abort(): Promise<void> };

type Options = {
  transport: UploadTransport;
  /** Uploads running at once. Three leaves browser connections for navigation and live events. */
  concurrency?: number;
  /** Progress is published at most this often, so thousands of items never re-render per event. */
  publishIntervalMs?: number;
  onUploaded?: (request: UploadRequest) => void;
  /** Runs when the last running upload ends, with the outcome of everything since the last idle. */
  onIdle?: (summary: UploadSummary) => void;
};

const emptySummary: UploadSummary = {
  total: 0,
  queued: 0,
  active: 0,
  done: 0,
  failed: 0,
  cancelled: 0,
  sentBytes: 0,
  totalBytes: 0,
};

function summarize(items: readonly UploadItem[]): UploadSummary {
  const summary = { ...emptySummary, total: items.length };
  for (const { request, status } of items) {
    summary.totalBytes += request.file.size;
    if (status.kind === "queued") summary.queued++;
    else if (status.kind === "uploading") {
      summary.active++;
      summary.sentBytes += status.sent;
    } else if (status.kind === "done") {
      summary.done++;
      summary.sentBytes += request.file.size;
    } else if (status.kind === "failed") summary.failed++;
    else summary.cancelled++;
  }
  return summary;
}

/**
 * A queue of independent uploads with bounded concurrency, per-item cancel and retry, and throttled
 * snapshots for `useSyncExternalStore`. It lives outside React so uploads survive navigation.
 */
export function createUploadQueue({
  transport,
  concurrency = 3,
  publishIntervalMs = 100,
  onUploaded,
  onIdle,
}: Options) {
  let items: UploadItem[] = [];
  const index = new Map<number, number>();
  const running = new Map<number, { abort(): Promise<void> }>();
  let nextId = 1;
  let snapshot: UploadSnapshot = { items: [], summary: emptySummary };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();

  const publish = () => {
    timer = null;
    snapshot = { items: items.slice(), summary: summarize(items) };
    for (const listener of listeners) listener();
  };
  const schedule = (immediate = false) => {
    if (immediate) {
      if (timer) clearTimeout(timer);
      publish();
      return;
    }
    timer ??= setTimeout(publish, publishIntervalMs);
  };
  const update = (id: number, status: UploadStatus) => {
    const position = index.get(id);
    const item = position === undefined ? undefined : items[position];
    if (position === undefined || !item) return;
    items[position] = { ...item, status };
  };

  let idleReported = true;
  const finish = (id: number, status: UploadStatus) => {
    running.delete(id);
    update(id, status);
    pump();
    schedule(true);
    if (running.size === 0 && !idleReported) {
      idleReported = true;
      onIdle?.(snapshot.summary);
    }
  };
  const wake = () => {
    idleReported = false;
    pump();
    schedule(true);
  };

  function pump() {
    for (const item of items) {
      if (running.size >= concurrency) return;
      if (item.status.kind !== "queued") continue;
      const { id, request } = item;
      update(id, { kind: "uploading", sent: 0 });
      let settled = false;
      const handle = transport(request, {
        progress(sent) {
          if (settled) return;
          update(id, {
            kind: "uploading",
            sent: Math.min(sent, request.file.size),
          });
          schedule();
        },
        success() {
          if (settled) return;
          settled = true;
          onUploaded?.(request);
          finish(id, { kind: "done" });
        },
        failure(message) {
          if (settled) return;
          settled = true;
          finish(id, { kind: "failed", message });
        },
      });
      // Cancelling marks the item settled before aborting, so late callbacks are ignored.
      running.set(id, {
        abort: async () => {
          settled = true;
          await handle.abort();
        },
      });
    }
  }

  const cancel = async (id: number) => {
    const position = index.get(id);
    const item = position === undefined ? undefined : items[position];
    if (
      !item ||
      (item.status.kind !== "queued" && item.status.kind !== "uploading")
    )
      return;
    const handle = running.get(id);
    finish(id, { kind: "cancelled" });
    await handle?.abort();
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    enqueue(requests: readonly UploadRequest[]) {
      for (const request of requests) {
        const id = nextId++;
        index.set(id, items.length);
        items.push({ id, request, status: { kind: "queued" } });
      }
      wake();
    },
    cancel,
    async cancelAll() {
      // Cancel queued items first, so finishing a running upload cannot start one of them.
      for (const item of items)
        if (item.status.kind === "queued")
          update(item.id, { kind: "cancelled" });
      const active = items.filter((item) => item.status.kind === "uploading");
      if (active.length === 0) schedule(true);
      await Promise.all(active.map((item) => cancel(item.id)));
    },
    /** Queue a failed or cancelled item again. */
    retry(id: number) {
      const position = index.get(id);
      const item = position === undefined ? undefined : items[position];
      if (
        !item ||
        (item.status.kind !== "failed" && item.status.kind !== "cancelled")
      )
        return;
      update(id, { kind: "queued" });
      wake();
    },
    retryFailed() {
      for (const item of items)
        if (item.status.kind === "failed") update(item.id, { kind: "queued" });
      wake();
    },
    /** Forget finished, failed, and cancelled items. Running and queued uploads stay. */
    clearFinished() {
      items = items.filter(
        (item) =>
          item.status.kind === "queued" || item.status.kind === "uploading",
      );
      index.clear();
      items.forEach((item, position) => index.set(item.id, position));
      schedule(true);
    },
    /** Abort everything without callbacks, for teardown. */
    dispose() {
      if (timer) clearTimeout(timer);
      for (const handle of running.values()) void handle.abort();
      running.clear();
      listeners.clear();
    },
  };
}

export type UploadQueue = ReturnType<typeof createUploadQueue>;
