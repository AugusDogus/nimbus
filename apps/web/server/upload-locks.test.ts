import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Upload } from "@tus/server";
import { getAccess } from "@nimbus/api/access";
import { setScopeAuthority } from "@nimbus/api/file-mutations";
import { createPathLocks } from "@nimbus/api/path-locks";
import { createTestDriveStore } from "@nimbus/api/testing";
import { createUploadServer } from "./routes/upload-server";
import { createUploadFinisher } from "./upload-publish";
import { UploadLocks } from "./upload-locks";
import { UploadStore } from "./upload-store";

/**
 * During an update a PATCH may still be writing on the old server while the client resumes on
 * the new one. Both servers' tus endpoints take one lock per upload from the scopes every
 * server shares, so only one of them writes, checks the offset or publishes at a time.
 */
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nimbus-upload-locks-"));
  // Every server takes scopes from one authority, as under the supervisor.
  setScopeAuthority(createPathLocks());
});
afterEach(async () => {
  setScopeAuthority(null);
  await rm(root, { recursive: true, force: true });
});

const server = () => {
  const memory = createTestDriveStore();
  return createUploadServer({
    store: new UploadStore({ directory: path.join(root, ".nimbus/uploads") }),
    drive: memory.store,
    access: () => getAccess(memory.store, "user-1"),
    fail: () => ({ status_code: 500, body: "failed" }),
  });
};

async function lockerOf(tus: ReturnType<typeof server>) {
  const { locker } = tus.options;
  return typeof locker === "function"
    ? await locker(new Request("http://localhost/api/upload"))
    : await locker;
}

test("two servers never hold one upload's lock at once", async () => {
  const [old, next] = [await lockerOf(server()), await lockerOf(server())];
  const writing = old.newLock("0123456789abcdef0123456789abcdef");
  await writing.lock(new AbortController().signal, async () => undefined);
  let resumed = false;
  const resuming = next.newLock("0123456789abcdef0123456789abcdef");
  const waiting = resuming
    .lock(new AbortController().signal, async () => undefined)
    .then(() => {
      resumed = true;
    });
  await Bun.sleep(50);
  expect(resumed).toBe(false);
  await writing.unlock();
  await waiting;
  expect(resumed).toBe(true);
  await resuming.unlock();
});

test("other uploads go ahead meanwhile", async () => {
  const [old, next] = [await lockerOf(server()), await lockerOf(server())];
  const one = old.newLock("0123456789abcdef0123456789abcdef");
  await one.lock(new AbortController().signal, async () => undefined);
  const other = next.newLock("fedcba9876543210fedcba9876543210");
  await other.lock(new AbortController().signal, async () => undefined);
  await other.unlock();
  await one.unlock();
});

test("publishing waits for a PATCH another server is still writing", async () => {
  const store = new UploadStore({
    directory: path.join(root, ".nimbus/uploads"),
  });
  const id = "0123456789abcdef0123456789abcdef";
  await store.create(new Upload({ id, size: 5, offset: 0, metadata: {} }));
  const writing = (await lockerOf(server())).newLock(id);
  await writing.lock(new AbortController().signal, async () => undefined);
  let published = false;
  const finisher = createUploadFinisher(store);
  const finishing = finisher.finish(id, async () => {
    published = true;
  });
  await Bun.sleep(50);
  expect(published).toBe(false);
  // The PATCH completes the upload, then lets go.
  await store.write(Readable.from([Buffer.from("hello")]), id, 0);
  await writing.unlock();
  await finishing;
  expect(published).toBe(true);
});

test("a lock held for a HEAD handler that never takes it is let go", async () => {
  const id = "0123456789abcdef0123456789abcdef";
  // As when `onIncomingRequest` fails after recovery: tus never asks for the lock.
  await UploadLocks.holdThroughHandler(
    new Request("http://localhost/api/upload", { method: "HEAD" }),
    id,
    async () => undefined,
  );
  const next = (await lockerOf(server())).newLock(id);
  await next.lock(new AbortController().signal, async () => undefined);
  await next.unlock();
});

test("the HEAD handler of the same request takes the lock over without waiting", async () => {
  const id = "0123456789abcdef0123456789abcdef";
  const request = new Request("http://localhost/api/upload", {
    method: "HEAD",
  });
  await UploadLocks.holdThroughHandler(request, id, async () => undefined);
  const tus = server();
  const handler = (
    typeof tus.options.locker === "function"
      ? await tus.options.locker(request)
      : await tus.options.locker
  ).newLock(id);
  await handler.lock(new AbortController().signal, async () => undefined);
  // Another request waits until that handler is done.
  let other = false;
  const waiting = (await lockerOf(tus)).newLock(id);
  const taking = waiting
    .lock(new AbortController().signal, async () => undefined)
    .then(() => {
      other = true;
    });
  await Bun.sleep(30);
  expect(other).toBe(false);
  await handler.unlock();
  await taking;
  await waiting.unlock();
});
