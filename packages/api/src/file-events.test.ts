import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import {
  iterateFileEvents,
  maxQueuedFileEvents,
  publishFileEvent,
} from "./file-events";
import { appRouter, SESSION_RECHECK_MS } from "./routers";
import { createTestDriveStore } from "./testing";

let root: string;
let previousRoot: string | undefined;
beforeEach(async () => {
  previousRoot = process.env.NIMBUS_DATA_ROOT;
  root = await mkdtemp("/var/tmp/nimbus-events-");
  process.env.NIMBUS_DATA_ROOT = root;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
  else process.env.NIMBUS_DATA_ROOT = previousRoot;
});

const event = (index: number) => ({
  path: path.join(root, `file-${index}.txt`),
  event: "change" as const,
  ts: index,
});

test("a subscriber that falls behind gets one overflow notice instead of an ever longer queue", async () => {
  const controller = new AbortController();
  const events = iterateFileEvents(controller.signal, 3);
  // Subscribes on the first request for an item.
  const first = events.next();
  publishFileEvent(event(0));
  expect((await first).value).toEqual({ kind: "event", event: event(0) });
  for (let index = 1; index <= 10; index++) publishFileEvent(event(index));
  expect((await events.next()).value).toEqual({ kind: "overflow" });
  // Later events arrive again as usual.
  const next = events.next();
  publishFileEvent(event(11));
  expect((await next).value).toEqual({ kind: "event", event: event(11) });
  controller.abort();
  expect((await events.next()).done).toBe(true);
});

test("live updates tell a subscriber that fell behind to reload", async () => {
  const memory = createTestDriveStore();
  const controller = new AbortController();
  const updates = await appRouter
    .createCaller(
      {
        headers: new Headers(),
        session: { user: { id: "user-1" } },
        sessionStillValid: async () => true,
        drive: memory.store,
        preferences: {
          getUserPreferences: async () => null,
          setUserPreferences: async (_id, value) => value,
        },
      },
      { signal: controller.signal },
    )
    .files.onChange({});
  const iterator = updates[Symbol.asyncIterator]();
  // Each update arrives in tRPC's tracked envelope: [id, data, marker].
  const data = (result: IteratorResult<unknown>): unknown => {
    if (!Array.isArray(result.value)) return result.value;
    const envelope: unknown[] = result.value;
    return envelope[1];
  };
  const first = iterator.next();
  await Bun.sleep(10);
  // More changes land at once than the subscriber may fall behind by.
  for (let index = 0; index <= maxQueuedFileEvents; index++)
    publishFileEvent(event(index));
  expect(data(await first)).toMatchObject({ kind: "resync" });
  const next = iterator.next();
  publishFileEvent(event(0));
  expect(data(await next)).toMatchObject({
    kind: "delta",
    path: "file-0.txt",
  });
  controller.abort();
});

test("a subscriber whose session ended gets no reload notice, and its stream ends", async () => {
  const memory = createTestDriveStore();
  const controller = new AbortController();
  const updates = await appRouter
    .createCaller(
      {
        headers: new Headers(),
        session: { user: { id: "user-1" } },
        sessionStillValid: async () => false,
        drive: memory.store,
        preferences: {
          getUserPreferences: async () => null,
          setUserPreferences: async (_id, value) => value,
        },
      },
      { signal: controller.signal },
    )
    .files.onChange({});
  const iterator = updates[Symbol.asyncIterator]();
  const first = iterator.next();
  await Bun.sleep(SESSION_RECHECK_MS + 10);
  for (let index = 0; index <= maxQueuedFileEvents; index++)
    publishFileEvent(event(index));
  expect(await first).toMatchObject({ done: true });
  controller.abort();
});
