/**
 * The server's reaction to file changes, for the benchmark's burst scenario: the file
 * watcher with everything it feeds (its workers, the search index, live updates) and
 * live-update subscribers like open browser tabs. Run by files-bench.ts inside a
 * memory-capped cgroup, with its configuration in the environment. Prints one JSON line when
 * ready, then one per second with its RSS, longest event-loop stall and live events
 * delivered, until stdin closes.
 */
import { appRouter } from "@nimbus/api/routers";
import { db } from "../db";
import { createDriveStore } from "../drive-store";
import { ensureFileWatcher } from "../file-watcher";

const subscribers = Number(process.env.NIMBUS_BENCH_SUBSCRIBERS ?? "3");
const store = createDriveStore(db);
const controller = new AbortController();
let delivered = 0;
let stallMax = 0;
let last = performance.now();
setInterval(() => {
  const now = performance.now();
  stallMax = Math.max(stallMax, now - last - 10);
  last = now;
}, 10);

ensureFileWatcher();
for (let index = 0; index < subscribers; index++) {
  const caller = appRouter.createCaller(
    {
      headers: new Headers(),
      session: { user: { id: "admin" } },
      sessionStillValid: async () => true,
      drive: store,
      preferences: {
        getUserPreferences: async () => null,
        setUserPreferences: async (_id, value) => value,
      },
    },
    { signal: controller.signal },
  );
  const events = await caller.files.onChange({});
  void (async () => {
    try {
      for await (const event of events) {
        void event;
        delivered++;
      }
    } catch {
      // Stopped.
    }
  })();
}
// Let the watcher attach before the burst starts.
await Bun.sleep(1000);
const report = (type: string) =>
  console.log(
    JSON.stringify({
      type,
      rss: process.memoryUsage.rss(),
      stallMax: Math.round(stallMax),
      delivered,
    }),
  );
report("ready");
setInterval(() => report("sample"), 1000);
// Runs until the benchmark closes stdin.
await Bun.stdin.text();
controller.abort();
process.exit(0);
