import { describe, expect, it } from "bun:test";
import type { SearchRequest } from "@nimbus/api/search-index";
import { createSearchBridge, type SearchWorkerPort } from "./search-bridge";
import type { SearchInbound, SearchOutbound } from "./search-protocol";

/** A search worker that records what it is sent and answers only when told. */
function fakeWorker() {
  const sent: SearchInbound[] = [];
  let terminated = 0;
  const port: SearchWorkerPort = {
    postMessage: (message) => sent.push(message),
    terminate: () => {
      terminated++;
    },
    onmessage: null,
    onerror: null,
  };
  return {
    port,
    sent,
    get terminated() {
      return terminated;
    },
    searches: () =>
      sent.flatMap((message) => (message.type === "search" ? [message] : [])),
    cancels: () =>
      sent.flatMap((message) =>
        message.type === "cancel" ? [message.id] : [],
      ),
    answer(message: SearchOutbound) {
      port.onmessage?.(new MessageEvent("message", { data: message }));
    },
  };
}

const request: SearchRequest = {
  query: "notes",
  root: "",
  limit: 10,
  scope: { type: "all" },
};
const answer = {
  hits: [],
  truncated: false,
  total: 0,
  next: null,
  restarted: false,
  terms: [],
  complete: true,
};

function bridge(options: Partial<Parameters<typeof createSearchBridge>[0]>) {
  const workers: ReturnType<typeof fakeWorker>[] = [];
  const created = createSearchBridge({
    spawn: () => {
      const worker = fakeWorker();
      workers.push(worker);
      return worker.port;
    },
    root: () => "/data",
    ...options,
  });
  return { ...created, workers };
}

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return error instanceof Error && "code" in error ? error.code : error;
  }
};

describe("search bridge", () => {
  it("tells the worker to drop a search once its caller has stopped waiting", async () => {
    const { service, workers } = bridge({ queryTimeoutMs: 5 });
    const pending = service.search(request, { caller: "a" });
    expect(await code(pending)).toBe("TIMEOUT");
    const [worker] = workers;
    const [sent] = worker?.searches() ?? [];
    expect(worker?.cancels()).toEqual([sent?.id]);
    // The worker stops it too, should it have started.
    expect(sent?.request.deadline).toBeNumber();
  });

  it("bounds each caller's searches in flight, without holding up anyone else", async () => {
    const { service, workers } = bridge({ perCaller: 2, total: 10 });
    const first = service.search(request, { caller: "a" });
    service.search(request, { caller: "a" }).catch(() => undefined);
    expect(await code(service.search(request, { caller: "a" }))).toBe(
      "TOO_MANY_REQUESTS",
    );
    const other = service.search(request, { caller: "b" });
    const worker = workers[0];
    const searches = worker?.searches() ?? [];
    expect(searches.map((message) => message.caller)).toEqual(["a", "a", "b"]);
    for (const message of searches)
      worker?.answer({ type: "result", id: message.id, answer });
    expect(await first).toEqual(answer);
    expect(await other).toEqual(answer);
    // Answered searches no longer count.
    const again = service.search(request, { caller: "a" });
    worker?.answer({
      type: "result",
      id: worker.searches().at(-1)?.id ?? 0,
      answer,
    });
    expect(await again).toEqual(answer);
  });

  it("bounds everyone's searches in flight together", async () => {
    const { service } = bridge({ perCaller: 5, total: 3 });
    for (const caller of ["a", "b", "c"])
      service.search(request, { caller }).catch(() => undefined);
    expect(await code(service.search(request, { caller: "d" }))).toBe(
      "TOO_MANY_REQUESTS",
    );
  });

  it("counts a cancelled search as no longer in flight", async () => {
    const { service, workers } = bridge({ perCaller: 1 });
    const controller = new AbortController();
    const first = service.search(request, {
      caller: "a",
      signal: controller.signal,
    });
    controller.abort();
    expect(await code(first)).toBe("CLIENT_CLOSED_REQUEST");
    expect(workers[0]?.cancels()).toHaveLength(1);
    const second = service.search(request, { caller: "a" });
    workers[0]?.answer({
      type: "result",
      id: workers[0].searches().at(-1)?.id ?? 0,
      answer,
    });
    expect(await second).toEqual(answer);
  });

  it("ends a worker that failed, fails what it held, and starts a fresh one", async () => {
    const { service, workers } = bridge({});
    const pending = service.search(request, { caller: "a" });
    workers[0]?.port.onerror?.(new ErrorEvent("error", { message: "boom" }));
    expect(await code(pending)).toBe("INTERNAL_SERVER_ERROR");
    expect(workers[0]?.terminated).toBe(1);
    service.search(request, { caller: "a" }).catch(() => undefined);
    expect(workers).toHaveLength(2);
    expect(workers[1]?.searches()).toHaveLength(1);
  });

  it("limits how often one caller may search", async () => {
    const { service, workers } = bridge({
      perCaller: 100,
      rate: { limit: 3, windowMs: 60_000 },
    });
    for (let search = 0; search < 3; search++)
      service.search(request, { caller: "a" }).catch(() => undefined);
    expect(await code(service.search(request, { caller: "a" }))).toBe(
      "TOO_MANY_REQUESTS",
    );
    expect(workers[0]?.searches()).toHaveLength(3);
    service.search(request, { caller: "b" }).catch(() => undefined);
    expect(workers[0]?.searches()).toHaveLength(4);
  });
});
