import { afterEach, beforeEach, expect, test } from "bun:test";
import { Server } from "@tus/server";
import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UploadStore } from "./upload-store";

let root: string;
let store: UploadStore;
let destination: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nimbus-upload-"));
  const directory = path.join(root, ".nimbus/uploads");
  await mkdir(directory, { recursive: true });
  store = new UploadStore({ directory });
  destination = path.join(root, "uploaded.txt");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("publishing shares file data and staging cleanup preserves the destination", async () => {
  const source = path.join(store.directory, "upload");
  await writeFile(source, "original bytes");
  await store.publish("upload", destination);
  const staged = await stat(source);
  const published = await stat(destination);
  expect([published.dev, published.ino]).toEqual([staged.dev, staged.ino]);
  expect(published.nlink).toBe(2);
  await rm(source);
  expect(await readFile(destination, "utf8")).toBe("original bytes");
});

test("publishing never overwrites a different existing file", async () => {
  await writeFile(path.join(store.directory, "upload"), "new upload");
  await writeFile(destination, "keep this file");
  await expect(store.publish("upload", destination)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(destination, "utf8")).toBe("keep this file");
  expect(await store.isFinished("upload")).toBe(false);
});

test("retry recovers an interrupted publication without creating another file", async () => {
  const source = path.join(store.directory, "upload");
  await writeFile(source, "original bytes");
  await link(source, destination);
  await store.publish("upload", destination);
  await store.publish("upload", path.join(root, "duplicate.txt"));
  expect(await store.isFinished("upload")).toBe(true);
  expect((await readdir(root)).sort()).toEqual([".nimbus", "uploaded.txt"]);
});

test("failed completion marker remains retryable", async () => {
  await writeFile(path.join(store.directory, "upload"), "original bytes");
  const temporary = path.join(store.directory, "upload.done.tmp");
  await mkdir(temporary);
  await expect(store.publish("upload", destination)).rejects.toBeDefined();
  expect(await store.isFinished("upload")).toBe(false);
  await rm(temporary, { recursive: true });
  await store.publish("upload", destination);
  expect(await store.isFinished("upload")).toBe(true);
  expect(await readFile(destination, "utf8")).toBe("original bytes");
});

function tusServer() {
  return new Server({
    path: "/upload",
    datastore: store,
    async onUploadFinish(_request, upload) {
      await store.publish(upload.id, destination);
      return {};
    },
  });
}

async function createUpload(server: Server, size: number) {
  const response = await server.handleWeb(new Request("http://localhost/upload", {
    method: "POST",
    headers: { "Tus-Resumable": "1.0.0", "Upload-Length": String(size) },
  }));
  expect(response.status).toBe(201);
  const location = response.headers.get("location");
  if (!location) throw new Error("The tus server did not return an upload location.");
  return new URL(location, "http://localhost").href;
}

async function patch(server: Server, url: string, offset: number, body: string) {
  return server.handleWeb(new Request(url, {
    method: "PATCH",
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Offset": String(offset),
      "Content-Type": "application/offset+octet-stream",
    },
    body,
  }));
}

test("tus resumes partial uploads and retries completed uploads after external edits", async () => {
  let server = tusServer();
  const url = await createUpload(server, 6);
  expect((await patch(server, url, 0, "abc")).status).toBe(204);
  expect((await readdir(root))).not.toContain("uploaded.txt");
  expect((await patch(server, url, 3, "def")).status).toBe(204);
  expect(await readFile(destination, "utf8")).toBe("abcdef");
  // An external in-place edit changes both hardlinks, including their size.
  await writeFile(destination, "x");
  store = new UploadStore({ directory: store.directory });
  server = tusServer();
  const head = await server.handleWeb(new Request(url, {
    method: "HEAD", headers: { "Tus-Resumable": "1.0.0" },
  }));
  expect(head.status).toBe(200);
  expect(head.headers.get("upload-offset")).toBe("6");
  expect((await patch(server, url, 6, "")).status).toBe(204);
  expect((await patch(server, url, 1, "overwrite")).status).toBe(409);
  expect((await patch(server, url, 6, "extra bytes")).status).toBeGreaterThanOrEqual(400);
  expect(await readFile(destination, "utf8")).toBe("x");
  expect((await readdir(root)).sort()).toEqual([".nimbus", "uploaded.txt"]);
});

test("tus publishes empty uploads", async () => {
  await createUpload(tusServer(), 0);
  expect(await readFile(destination, "utf8")).toBe("");
});

test.skipIf(!existsSync("/dev/shm"))("publishing across filesystems falls back to a copy", async () => {
  const otherRoot = await mkdtemp("/dev/shm/nimbus-upload-");
  try {
    const source = path.join(store.directory, "upload");
    const target = path.join(otherRoot, "uploaded.txt");
    await writeFile(source, "cross-filesystem bytes");
    expect((await stat(root)).dev).not.toBe((await stat(otherRoot)).dev);
    await store.publish("upload", target);
    expect(await readFile(target, "utf8")).toBe("cross-filesystem bytes");
    expect((await stat(source)).nlink).toBe(1);
    expect(await store.isFinished("upload")).toBe(true);
  } finally {
    await rm(otherRoot, { recursive: true, force: true });
  }
});
