import { expect, test } from "bun:test";
import { FileWatchThread } from "./file-watch-thread";
import type { FileEvent } from "./watch.worker";

test("the server keeps running while its file watch takes seconds to set up, and changes still arrive", async () => {
  const root = "/srv/drive";
  const events: FileEvent[] = [];
  const arrived = Promise.withResolvers<void>();
  const handle = FileWatchThread.start({
    spawn: () =>
      new Worker(
        new URL("./file-watch-slow.thread-testing.ts", import.meta.url),
        { type: "module" },
      ),
    root,
    debounceMs: 0,
    recheckMs: 60_000,
    emit: (event) => {
      events.push(event);
      arrived.resolve();
    },
    onLost: () => undefined,
    log: () => undefined,
  });
  let last = performance.now();
  let longest = 0;
  const ticking = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last - 10);
    last = now;
  }, 10);
  await arrived.promise;
  clearInterval(ticking);
  expect(longest).toBeLessThan(200);
  expect(events.map((event) => event.path)).toEqual(["/srv/drive/added.txt"]);
  expect(handle.watching()).toBe(true);
  handle.close();
  expect(handle.watching()).toBe(false);
});
