import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAccess } from "@nimbus/api/access";
import { isApiError } from "@nimbus/api/safe-path";
import { createTestDriveStore } from "@nimbus/api/testing";
import { UploadStore } from "@/server/upload-store";
import { createUploadServer } from "./upload-server";

const base64 = (value: string) => Buffer.from(value).toString("base64");

describe("signed-in tus uploads", () => {
  let root: string;
  let previousRoot: string | undefined;
  let server: ReturnType<typeof createUploadServer>;

  const send = (method: string, url: string, headers: Record<string, string> = {}, body?: string) =>
    server.handleWeb(new Request(url, { method, headers: { "Tus-Resumable": "1.0.0", ...headers }, body }));

  beforeEach(async () => {
    previousRoot = process.env.NIMBUS_DATA_ROOT;
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-upload-server-"));
    process.env.NIMBUS_DATA_ROOT = root;
    await mkdir(path.join(root, ".nimbus/uploads"), { recursive: true });
    await mkdir(path.join(root, "docs"));
    const memory = createTestDriveStore();
    server = createUploadServer({
      store: new UploadStore({ directory: path.join(root, ".nimbus/uploads") }),
      access: () => getAccess(memory.store, "user-1"),
      fail: (error) => ({
        status_code: isApiError(error, "NOT_FOUND") ? 404 : 500,
        body: error instanceof Error ? error.message : "failed",
      }),
    });
  });
  afterEach(async () => {
    globalThis.nimbusFileMutations?.delete(root);
    await rm(root, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
    else process.env.NIMBUS_DATA_ROOT = previousRoot;
  });

  it("accepts metadata keys sent without a value, as tus-js-client sends empty strings", async () => {
    const created = await send("POST", "http://localhost/api/upload", {
      "Upload-Length": "2",
      "Upload-Metadata": `filename ${base64("b.txt")},targetPath ${base64("docs")},folder,conflict ${base64("keep-both")}`,
      "Content-Type": "application/offset+octet-stream",
    }, "hi");
    expect(created.status).toBe(201);
    expect(await readFile(path.join(root, "docs/b.txt"), "utf8")).toBe("hi");
  });

  it("publishes on resume when a complete upload failed to publish", async () => {
    const created = await send("POST", "http://localhost/api/upload", {
      "Upload-Length": "5",
      "Upload-Metadata": `filename ${base64("a.txt")},targetPath ${base64("docs")}`,
    });
    expect(created.status).toBe(201);
    const location = created.headers.get("location");
    if (!location) throw new Error("The tus server did not return an upload location.");
    const url = new URL(location, "http://localhost/api/upload/").href;

    // The destination disappears while the bytes arrive, so publishing fails after a full transfer.
    await rm(path.join(root, "docs"), { recursive: true });
    const patched = await send("PATCH", url, { "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream" }, "hello");
    expect(patched.status).toBe(404);

    // A resuming client must not see a complete upload until the file exists.
    expect((await send("HEAD", url)).status).toBe(404);
    await mkdir(path.join(root, "docs"));
    const resumed = await send("HEAD", url);
    expect(resumed.status).toBe(200);
    expect(resumed.headers.get("upload-offset")).toBe("5");
    expect(await readFile(path.join(root, "docs/a.txt"), "utf8")).toBe("hello");
    expect((await send("HEAD", url)).status).toBe(200);
    expect(await readdir(path.join(root, "docs"))).toEqual(["a.txt"]);
  });
});
