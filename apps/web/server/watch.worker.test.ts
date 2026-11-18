import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  FileEvent,
  FileWatchHandle,
  FileWatchOptions,
  WatchTree,
} from "./watch.worker";
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
    if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
    else process.env.NIMBUS_DATA_ROOT = previousRoot;
    if (previousDebounce === undefined)
      delete process.env.NIMBUS_WATCH_DEBOUNCE_MS;
    else process.env.NIMBUS_WATCH_DEBOUNCE_MS = previousDebounce;
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
    const nextMessage = waitForEvent(queue);
    await writeFile(filePath, "v1");
    await nextMessage;

    const nextMessageAfterUpdate = waitForEvent(queue);
    await writeFile(filePath, "v2");
    const message = await nextMessageAfterUpdate;
    expect(message.path).toBe(filePath);
    expect(["rename", "change"]).toContain(message.event);
  });

  it("emits event when a file is deleted", async () => {
    const filePath = path.join(root, "deleted.txt");
    const nextMessage = waitForEvent(queue);
    await writeFile(filePath, "v1");
    await nextMessage;

    const nextMessageAfterDelete = waitForEvent(queue);
    await unlink(filePath);
    const message = await nextMessageAfterDelete;
    expect(message.path).toBe(filePath);
    expect(["rename", "change"]).toContain(message.event);
  });

  it("observes files in directories created after the watcher starts", async () => {
    const directory = path.join(root, "new-folder", "nested");
    await mkdir(directory, { recursive: true });
    await collectEvents(queue, debounceMs * 2);
    const filename = path.join(directory, "external.txt");
    await writeFile(filename, "external");
    const messages = await collectEvents(queue, debounceMs * 4);
    expect(messages.some((event) => event.path === filename)).toBe(true);
  });

  it("does not emit changes from private Nimbus storage", async () => {
    const directory = path.join(root, ".NIMBUS", "uploads");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "private.json"), "internal metadata");
    expect(await collectEvents(queue, debounceMs * 4)).toEqual([]);
  });

  it("debounces rapid changes to the same file", async () => {
    const filePath = path.join(root, "debounce.txt");
    const nextMessage = waitForEvent(queue);
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

const asRoot = process.getuid?.() === 0;
const rootSkip = "running as root, where folder permissions do not apply";
if (asRoot)
  console.warn(`Skipping the unreadable folder watcher test: ${rootSkip}.`);

/** Wait until `check` holds, polling, or fail after `timeoutMs`. */
async function until(check: () => boolean, what: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting: ${what}.`);
    await Bun.sleep(10);
  }
}

/** A stack trace in a log line: the log must say what happened, not dump an error. */
const stackLine = /\n\s+at /;

describe("watch.worker with folders it cannot read", () => {
  let root: string;
  let handle: FileWatchHandle | null = null;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-watch-unreadable-"));
    await mkdir(path.join(root, "open"));
    await mkdir(path.join(root, "locked/inner"), { recursive: true });
    await chmod(path.join(root, "locked"), 0);
  });

  afterEach(async () => {
    handle?.close();
    handle = null;
    for (const folder of ["locked", "open/late"])
      await chmod(path.join(root, folder), 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  it.skipIf(asRoot)(
    `keeps watching everything else, logs each unreadable folder once, and watches it once it can be read${asRoot ? ` (skipped: ${rootSkip})` : ""}`,
    async () => {
      const events: FileEvent[] = [];
      const logs: string[] = [];
      let lost = 0;
      handle = startFileWatch(
        root,
        20,
        (event) => events.push(event),
        () => lost++,
        { log: (message) => logs.push(message), recheckMs: 200 },
      );
      // Created unreadable after the watch started, as another program's folder would be.
      await mkdir(path.join(root, "open/late"), { mode: 0 });
      await until(() => logs.length >= 2, "both unreadable folders logged");
      // More events next to and on the unreadable folders.
      await chmod(path.join(root, "locked"), 0);
      for (let i = 0; i < 5; i++)
        await writeFile(path.join(root, "open", `file-${i}.txt`), "x");
      const last = path.join(root, "open/file-4.txt");
      await until(
        () => events.some((event) => event.path === last),
        "an event beside the unreadable folders",
      );
      expect(logs).toHaveLength(2);
      expect(
        logs.some((line) => line.includes(path.join(root, "locked"))),
      ).toBe(true);
      expect(
        logs.some((line) => line.includes(path.join(root, "open/late"))),
      ).toBe(true);
      for (const line of logs) expect(line).not.toMatch(stackLine);

      await chmod(path.join(root, "locked"), 0o755);
      await until(() => lost > 0, "the readable folder rescanned", 2000);
      const inside = path.join(root, "locked/inner/now-readable.txt");
      await writeFile(inside, "x");
      await until(
        () => events.some((event) => event.path === inside),
        "an event inside the folder that became readable",
      );
      // Still unreadable after the watch restarted, and not logged again.
      expect(logs).toHaveLength(2);
    },
  );
});

type FakeWatcher = {
  listener: (event: string, filename: string | null) => void;
  closed: boolean;
  fail: (error: Error) => void;
};

/**
 * A stand-in for fs.watch that records each watch and lets a test make it fail. `refuse`
 * holds errors the next calls throw, as fs.watch throws when it cannot start at all.
 */
function fakeWatches(onCreate: (watcher: FakeWatcher) => void = () => {}) {
  const made: FakeWatcher[] = [];
  const refuse: Error[] = [];
  const watch: WatchTree = (_root, listener) => {
    const refused = refuse.shift();
    if (refused) throw refused;
    const errors = new EventEmitter();
    const watcher: FakeWatcher = {
      listener,
      closed: false,
      fail: (error) => errors.emit("error", error),
    };
    made.push(watcher);
    queueMicrotask(() => onCreate(watcher));
    return {
      on: (event, listen) => errors.on(event, listen),
      close: () => {
        watcher.closed = true;
      },
    };
  };
  return { watch, made, refuse };
}

/** An error shaped like the ones fs.watch reports. */
const watchError = (code: string, at: string) =>
  Object.assign(new Error(`${code}: injected, watch '${at}'`), {
    code,
    path: at,
    syscall: "watch",
  });

describe("watch.worker failures", () => {
  const root = path.join(os.tmpdir(), "nimbus-watch-fake-root");
  let handle: FileWatchHandle | null = null;
  let logs: string[] = [];
  let lost = 0;

  const start = (watch: WatchTree, options: FileWatchOptions = {}) => {
    handle = startFileWatch(
      root,
      10,
      () => {},
      () => lost++,
      { watch, log: (message) => logs.push(message), retryMs: 10, ...options },
    );
    return handle;
  };

  beforeEach(() => {
    logs = [];
    lost = 0;
  });
  afterEach(() => {
    handle?.close();
    handle = null;
  });

  it("stops watching at the inotify watch limit, releases its watches and says how to raise it, once", async () => {
    const fake = fakeWatches();
    const watching = start(fake.watch);
    fake.made[0]?.fail(watchError("ENOSPC", path.join(root, "a")));
    fake.made[0]?.fail(watchError("ENOSPC", path.join(root, "b")));
    await Bun.sleep(100);
    expect(fake.made).toHaveLength(1);
    expect(fake.made[0]?.closed).toBe(true);
    expect(watching.watching()).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("fs.inotify.max_user_watches");
    expect(logs[0]).not.toMatch(stackLine);
  });

  for (const code of ["EMFILE", "ENFILE"])
    it(`restarts after ${code} with a wait, logs once and rescans what it missed`, async () => {
      const fake = fakeWatches();
      // It cannot start, and then the restarted watch fails the same way.
      fake.refuse.push(watchError(code, root));
      const watching = start(fake.watch);
      expect(watching.watching()).toBe(false);
      await until(() => fake.made.length === 1, "the watch restarted");
      expect(watching.watching()).toBe(true);
      expect(lost).toBe(1);
      fake.made[0]?.fail(watchError(code, path.join(root, "a")));
      expect(fake.made[0]?.closed).toBe(true);
      await until(() => fake.made.length === 2, "the watch restarted again");
      expect(lost).toBe(2);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain(code);
      expect(logs[0]).not.toMatch(stackLine);
    });

  for (const code of ["ENOENT", "ENOTDIR", "ELOOP"])
    it(`ignores ${code} for a folder below the root that went away while it was added`, async () => {
      const fake = fakeWatches();
      const watching = start(fake.watch);
      fake.made[0]?.fail(watchError(code, path.join(root, "gone")));
      await Bun.sleep(50);
      expect(fake.made).toHaveLength(1);
      expect(fake.made[0]?.closed).toBe(false);
      expect(watching.watching()).toBe(true);
      expect(logs).toEqual([]);
    });

  it("treats EPERM like EACCES: the folder is logged once and the rest stays watched", async () => {
    const fake = fakeWatches();
    start(fake.watch);
    // Bun reports a refused inotify watch as EPERM.
    fake.made[0]?.fail(watchError("EPERM", path.join(root, "x")));
    fake.made[0]?.fail(watchError("EPERM", path.join(root, "x")));
    fake.made[0]?.fail(watchError("EACCES", path.join(root, "y")));
    await Bun.sleep(50);
    expect(fake.made).toHaveLength(1);
    expect(fake.made[0]?.closed).toBe(false);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain(path.join(root, "x"));
    expect(logs[1]).toContain(path.join(root, "y"));
  });

  for (const code of ["ENAMETOOLONG", "EIO"])
    it(`skips one folder it cannot watch for ${code}, logging it once, and keeps watching the rest`, async () => {
      const fake = fakeWatches();
      start(fake.watch);
      const folder = path.join(root, "deep");
      fake.made[0]?.fail(watchError(code, folder));
      fake.made[0]?.fail(watchError(code, folder));
      await Bun.sleep(50);
      expect(fake.made).toHaveLength(1);
      expect(fake.made[0]?.closed).toBe(false);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain(folder);
      expect(logs[0]).toContain(code);
    });

  it("restarts after the root itself becomes unreadable", async () => {
    const fake = fakeWatches();
    start(fake.watch);
    fake.made[0]?.fail(watchError("EACCES", root));
    expect(fake.made[0]?.closed).toBe(true);
    await until(() => fake.made.length === 2, "the watch restarted");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(root);
  });

  it("logs an unknown error once and restarts with growing waits instead of spinning", async () => {
    // Every watch fails as soon as it starts, for the root itself.
    const fake = fakeWatches((watcher) =>
      watcher.fail(watchError("EIO", root)),
    );
    const watching = start(fake.watch);
    await Bun.sleep(400);
    // Waits of 10, 20, 40, 80 and 160 ms fit about five restarts in 400 ms; a loop without
    // backoff would make hundreds.
    expect(fake.made.length).toBeGreaterThanOrEqual(3);
    expect(fake.made.length).toBeLessThanOrEqual(7);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("EIO");
    expect(logs[0]).not.toMatch(stackLine);
    expect(watching.watching()).toBe(false);
  });

  it("closing stops a pending restart", async () => {
    const fake = fakeWatches();
    start(fake.watch);
    fake.made[0]?.fail(watchError("EIO", root));
    handle?.close();
    await Bun.sleep(50);
    expect(fake.made).toHaveLength(1);
  });
});

describe("watch.worker when the data root disappears", () => {
  let parent: string;
  let handle: FileWatchHandle | null = null;

  beforeEach(async () => {
    parent = await mkdtemp(path.join(os.tmpdir(), "nimbus-watch-root-gone-"));
  });
  afterEach(async () => {
    handle?.close();
    handle = null;
    await rm(parent, { recursive: true, force: true });
  });

  it("waits for it to come back, then watches it again and rescans", async () => {
    const root = path.join(parent, "data");
    await mkdir(root);
    const events: FileEvent[] = [];
    const logs: string[] = [];
    let lost = 0;
    handle = startFileWatch(
      root,
      20,
      (event) => events.push(event),
      () => lost++,
      { log: (message) => logs.push(message), retryMs: 20 },
    );
    await rm(root, { recursive: true });
    await until(() => logs.length === 1, "the missing root logged");
    expect(logs[0]).toContain(root);
    expect(handle.watching()).toBe(false);
    await Bun.sleep(100);
    // Retried, but logged once.
    expect(logs).toHaveLength(1);
    await mkdir(root);
    await until(() => lost > 0, "the returned root rescanned", 5000);
    expect(handle.watching()).toBe(true);
    const file = path.join(root, "back.txt");
    await writeFile(file, "x");
    await until(
      () => events.some((event) => event.path === file),
      "an event in the returned root",
    );
  });
});
