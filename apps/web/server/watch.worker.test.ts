import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FileEvent, FileWatchHandle } from "./watch.worker";
import { startFileWatch } from "./watch.worker";

const debounceMs = 50;

const waitForEvent = (queue: FileEvent[], timeoutMs = 2000) => {
  return new Promise<FileEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for watcher event."));
    }, timeoutMs);

    const interval = setInterval(() => {
      const event = queue.shift();
      if (event) {
        clearTimeout(timer);
        clearInterval(interval);
        resolve(event);
      }
    }, 5);
  });
};

const collectEvents = async (queue: FileEvent[], durationMs: number) => {
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  return queue.splice(0, queue.length);
};

describe("watch.worker", () => {
  let root: string;
  let handle: FileWatchHandle | null = null;
  let queue: FileEvent[] = [];
  let previousRoot: string | undefined;
  let previousDebounce: string | undefined;

  beforeEach(async () => {
    previousRoot = process.env.NIMBUS_DATA_ROOT;
    previousDebounce = process.env.NIMBUS_WATCH_DEBOUNCE_MS;
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-watch-"));
    process.env.NIMBUS_DATA_ROOT = root;
    process.env.NIMBUS_WATCH_DEBOUNCE_MS = String(debounceMs);
    queue = [];
    handle = startFileWatch(root, debounceMs, (event) => {
      queue.push(event);
    });
  });

  afterEach(async () => {
    handle?.close();
    handle = null;
    await rm(root, { recursive: true, force: true });
    process.env.NIMBUS_DATA_ROOT = previousRoot;
    process.env.NIMBUS_WATCH_DEBOUNCE_MS = previousDebounce;
  });

  it("emits event when a file is created", async () => {
    const filePath = path.join(root, "created.txt");
    const nextMessage = waitForEvent(queue);
    await writeFile(filePath, "hello");

    const message = await nextMessage;
    expect(message.path).toBe(filePath);
    expect(["rename", "change"]).toContain(message.event);
  });

  it("emits event when a file is modified", async () => {
    const filePath = path.join(root, "modified.txt");
    let nextMessage = waitForEvent(queue);
    await writeFile(filePath, "v1");
    await nextMessage;

    nextMessage = waitForEvent(queue);
    await writeFile(filePath, "v2");
    const message = await nextMessage;
    expect(message.path).toBe(filePath);
    expect(["rename", "change"]).toContain(message.event);
  });

  it("emits event when a file is deleted", async () => {
    const filePath = path.join(root, "deleted.txt");
    let nextMessage = waitForEvent(queue);
    await writeFile(filePath, "v1");
    await nextMessage;

    nextMessage = waitForEvent(queue);
    await unlink(filePath);
    const message = await nextMessage;
    expect(message.path).toBe(filePath);
    expect(["rename", "change"]).toContain(message.event);
  });

  it("debounces rapid changes to the same file", async () => {
    const filePath = path.join(root, "debounce.txt");
    let nextMessage = waitForEvent(queue);
    await writeFile(filePath, "start");
    await nextMessage;

    const messagesPromise = collectEvents(queue, debounceMs * 4);
    for (let i = 0; i < 10; i += 1) {
      await writeFile(filePath, `update-${i}`);
    }

    const messages = await messagesPromise;
    const matches = messages.filter((message) => message.path === filePath);
    expect(matches.length).toBe(1);
  });
});
