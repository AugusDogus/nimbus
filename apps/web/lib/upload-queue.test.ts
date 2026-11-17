import { describe, expect, it } from "bun:test";
import {
  createUploadQueue,
  type UploadRequest,
  type UploadSummary,
  type UploadTransport,
} from "./upload-queue";

const request = (filename: string, size = 10): UploadRequest => ({
  file: new File([new Uint8Array(size)], filename),
  filename,
  targetPath: "docs",
  folder: "",
  conflict: "keep-both",
  userId: "user-1",
});

function fakeTransport() {
  const started: {
    request: UploadRequest;
    progress(sent: number): void;
    succeed(): void;
    fail(message: string): void;
    aborted: boolean;
  }[] = [];
  const transport: UploadTransport = (request, events) => {
    const upload = {
      request,
      progress: events.progress,
      succeed: events.success,
      fail: events.failure,
      aborted: false,
    };
    started.push(upload);
    return {
      abort: async () => {
        upload.aborted = true;
      },
    };
  };
  return { started, transport };
}

describe("upload queue", () => {
  it("runs a bounded number of uploads and starts the next as each finishes", () => {
    const fake = fakeTransport();
    const queue = createUploadQueue({
      transport: fake.transport,
      concurrency: 2,
    });
    queue.enqueue(["a", "b", "c", "d"].map((name) => request(name)));
    expect(fake.started.map((upload) => upload.request.filename)).toEqual([
      "a",
      "b",
    ]);
    expect(queue.getSnapshot().summary).toMatchObject({
      total: 4,
      active: 2,
      queued: 2,
    });
    fake.started[0]?.succeed();
    expect(fake.started.map((upload) => upload.request.filename)).toEqual([
      "a",
      "b",
      "c",
    ]);
    fake.started[1]?.fail("The server is full.");
    expect(queue.getSnapshot().summary).toMatchObject({
      done: 1,
      failed: 1,
      active: 2,
      queued: 0,
    });
  });

  it("throttles progress publication and reports byte totals", async () => {
    const fake = fakeTransport();
    const queue = createUploadQueue({
      transport: fake.transport,
      publishIntervalMs: 20,
    });
    let publications = 0;
    queue.subscribe(() => publications++);
    queue.enqueue([request("a", 100)]);
    const before = publications;
    for (let sent = 1; sent <= 100; sent++) fake.started[0]?.progress(sent);
    expect(publications).toBe(before);
    await Bun.sleep(30);
    expect(publications).toBe(before + 1);
    expect(queue.getSnapshot().summary).toMatchObject({
      sentBytes: 100,
      totalBytes: 100,
    });
  });

  it("cancels one upload, ignores its late callbacks, and retries it on request", async () => {
    const fake = fakeTransport();
    const idle: UploadSummary[] = [];
    const queue = createUploadQueue({
      transport: fake.transport,
      onIdle: (summary) => idle.push(summary),
    });
    queue.enqueue([request("a"), request("b")]);
    const [first, second] = queue.getSnapshot().items;
    if (!first || !second) throw new Error("Expected two queued uploads");
    await queue.cancel(first.id);
    expect(fake.started[0]?.aborted).toBe(true);
    fake.started[0]?.succeed();
    expect(queue.getSnapshot().items[0]?.status).toEqual({ kind: "cancelled" });
    fake.started[1]?.succeed();
    expect(idle.at(-1)).toMatchObject({ done: 1, cancelled: 1 });
    queue.retry(first.id);
    expect(fake.started).toHaveLength(3);
    fake.started[2]?.succeed();
    expect(queue.getSnapshot().summary).toMatchObject({
      done: 2,
      cancelled: 0,
    });
    queue.clearFinished();
    expect(queue.getSnapshot().items).toEqual([]);
  });

  it("cancels everything at once and retries all failures", async () => {
    const fake = fakeTransport();
    let idle = 0;
    const queue = createUploadQueue({
      transport: fake.transport,
      concurrency: 1,
      onIdle: () => idle++,
    });
    queue.enqueue([request("a"), request("b"), request("c")]);
    fake.started[0]?.fail("Offline");
    await queue.cancelAll();
    expect(queue.getSnapshot().summary).toMatchObject({
      failed: 1,
      cancelled: 2,
      active: 0,
    });
    expect(fake.started.map((upload) => upload.request.filename)).toEqual([
      "a",
      "b",
    ]);
    expect(idle).toBe(1);
    queue.retryFailed();
    expect(fake.started.at(-1)?.request.filename).toBe("a");
  });

  it("keeps 5,000 queued items cheap to enqueue and summarize", () => {
    const fake = fakeTransport();
    const queue = createUploadQueue({ transport: fake.transport });
    const started = performance.now();
    queue.enqueue(
      Array.from({ length: 5000 }, (_, index) => request(`file ${index}`)),
    );
    for (let index = 0; index < 50; index++)
      fake.started[index % 3]?.progress(index);
    expect(queue.getSnapshot().summary.total).toBe(5000);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("runs 50,000 uploads in time linear in their number", async () => {
    let publications = 0;
    const done = Promise.withResolvers<UploadSummary>();
    const queue = createUploadQueue({
      // Each upload finishes as soon as it starts, so the queue's own work is what is measured.
      transport: (_request, events) => {
        queueMicrotask(events.success);
        return { abort: async () => {} };
      },
      onIdle: done.resolve,
    });
    queue.subscribe(() => publications++);
    const requests = Array.from({ length: 50_000 }, (_, index) =>
      request(`file ${index}`),
    );
    const started = performance.now();
    queue.enqueue(requests);
    const summary = await done.promise;
    const elapsed = performance.now() - started;
    expect(summary).toMatchObject({ total: 50_000, done: 50_000 });
    // Snapshots copy every item, so they are published on a timer, not once per upload.
    expect(publications).toBeLessThan(100);
    expect(elapsed).toBeLessThan(1000);
  });
});
