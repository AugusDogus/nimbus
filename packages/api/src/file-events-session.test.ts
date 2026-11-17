import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { publishFileEvent } from "./file-events";
import { appRouter, SESSION_RECHECK_MS } from "./routers";
import { createTestDriveStore } from "./testing";

let root: string;
let previousRoot: string | undefined;
beforeEach(async () => {
  previousRoot = process.env.NIMBUS_DATA_ROOT;
  root = await mkdtemp(path.join(os.tmpdir(), "nimbus-events-"));
  process.env.NIMBUS_DATA_ROOT = root;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
  else process.env.NIMBUS_DATA_ROOT = previousRoot;
});

test("a live event stream ends once its session is signed out", async () => {
  let signedIn = true;
  const controller = new AbortController();
  const caller = appRouter.createCaller(
    {
      headers: new Headers(),
      drive: createTestDriveStore().store,
      session: { user: { id: "user-1" } },
      sessionStillValid: async () => signedIn,
      preferences: {
        getUserPreferences: async () => null,
        setUserPreferences: async (_userId, prefs) => prefs,
      },
    },
    { signal: controller.signal },
  );
  const stream = await caller.files.onChange({});
  const iterator = stream[Symbol.asyncIterator]();
  const publish = async (name: string) => {
    await writeFile(path.join(root, name), "x");
    publishFileEvent({
      path: path.join(root, name),
      event: "rename",
      ts: Date.now(),
    });
  };

  const first = iterator.next();
  await Bun.sleep(5);
  await publish("before.txt");
  expect(await first).toMatchObject({ done: false });

  signedIn = false;
  await Bun.sleep(SESSION_RECHECK_MS);
  const second = iterator.next();
  await Bun.sleep(5);
  await publish("after.txt");
  const result = await Promise.race([
    second,
    Bun.sleep(500).then(() => "still open"),
  ]);
  controller.abort();
  expect(result).toMatchObject({ done: true });
});
