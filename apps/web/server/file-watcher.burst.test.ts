import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "./db/connection";
import { migrateDatabase } from "./db/migrate-database";
import { ServerChild } from "./server-child-testing";

/**
 * A large burst of new files in one folder while the server watches the drive, as rsync or
 * a WebDAV client copying a folder would. Each watcher event once re-listed the whole
 * folder in a worker, concurrently: 5,000 files took 3.3 GB and 50,000 more than 7 GB.
 * The server side runs in a child process with the real watcher wiring; the test stops it
 * as soon as it exceeds the memory bound, so a regression cannot exhaust the machine.
 */
const files = 10_000;
const subscribers = 3;
const maxRssBytes = 400 * 1024 * 1024;
const abortRssBytes = 1536 * 1024 * 1024;

// Bursts belong on disk: /tmp is often a RAM-backed tmpfs.
const scratch = existsSync("/var/tmp") ? "/var/tmp" : os.tmpdir();
let workspace: string;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(scratch, "nimbus-burst-"));
  await mkdir(path.join(workspace, "data/burst"), { recursive: true });
  await mkdir(path.join(workspace, "config"));
  const { sqlite } = openDatabase(path.join(workspace, "config/db.sqlite"));
  migrateDatabase(sqlite);
  sqlite.run(
    "INSERT INTO user (id, name, email, role) VALUES ('admin', 'Admin', 'admin@burst.test', 'admin')",
  );
  sqlite.close();
});
afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

test(
  "a burst of new files in one folder keeps the server's memory and pauses bounded",
  async () => {
    const child = Bun.spawn(
      ["bun", path.join(import.meta.dir, "bench/burst-server.ts")],
      {
        env: {
          ...process.env,
          NIMBUS_DATA_ROOT: path.join(workspace, "data"),
          NIMBUS_CONFIG_ROOT: path.join(workspace, "config"),
          DATABASE_URL: `file:${path.join(workspace, "config/db.sqlite")}`,
          BETTER_AUTH_SECRET: "burst-test-secret-burst-test-secret-0123",
          NIMBUS_BENCH_SUBSCRIBERS: String(subscribers),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
      },
    );
    let peakRss = 0;
    let stallMax = 0;
    let delivered = 0;
    let ready = () => {};
    const isReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const reading = (async () => {
      let buffered = "";
      const reader = child.stdout.getReader();
      for (
        let read = await reader.read();
        !read.done;
        read = await reader.read()
      ) {
        const chunk = read.value;
        buffered += new TextDecoder().decode(chunk);
        for (
          let end = buffered.indexOf("\n");
          end >= 0;
          end = buffered.indexOf("\n")
        ) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          // The server also logs plain text, such as when the index is ready.
          if (!line.startsWith("{")) continue;
          const sample: unknown = JSON.parse(line);
          if (typeof sample !== "object" || sample === null) continue;
          const read = (key: string) => {
            const value: unknown = Reflect.get(sample, key);
            return typeof value === "number" ? value : 0;
          };
          peakRss = Math.max(peakRss, read("rss"));
          stallMax = Math.max(stallMax, read("stallMax"));
          delivered = read("delivered");
          if (Reflect.get(sample, "type") === "ready") ready();
          if (peakRss > abortRssBytes) child.kill();
        }
      }
    })();
    try {
      await isReady;
      const content = Buffer.from("x");
      for (let start = 0; start < files; start += 500)
        await Promise.all(
          Array.from({ length: 500 }, (_, offset) =>
            writeFile(
              path.join(workspace, "data/burst", `file-${start + offset}.txt`),
              content,
            ),
          ),
        );
      const deadline = Date.now() + 60_000;
      while (
        delivered < files * subscribers &&
        Date.now() < deadline &&
        child.exitCode === null
      )
        await Bun.sleep(200);
      // The server's stderr is in the test output; this names how it ended, if it did.
      expect({
        server: ServerChild.exitOf(child),
        delivered: delivered >= files * subscribers,
        boundedMemory: peakRss < maxRssBytes,
        boundedStall: stallMax < 250,
      }).toEqual({
        server: "was still running",
        delivered: true,
        boundedMemory: true,
        boundedStall: true,
      });
    } finally {
      void child.stdin.end();
      child.kill();
      await child.exited;
      await reading;
    }
  },
  { timeout: 120_000 },
);
