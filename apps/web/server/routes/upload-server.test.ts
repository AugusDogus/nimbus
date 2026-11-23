import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAccess } from "@nimbus/api/access";
import { isApiError } from "@nimbus/api/safe-path";
import { createTestDriveStore } from "@nimbus/api/testing";
import { Readable } from "node:stream";
import { UploadLocks } from "@/server/upload-locks";
import { UploadStore } from "@/server/upload-store";
import { createUploadServer } from "./upload-server";
import { forgetFileMutationsForTest } from "@nimbus/api/file-mutations";

const base64 = (value: string) => Buffer.from(value).toString("base64");

describe("signed-in tus uploads", () => {
  let root: string;
  let previousRoot: string | undefined;
  let server: ReturnType<typeof createUploadServer>;
  /** Run once by the `remaining`th next read of an upload, before that read returns. */
  let interleave: {
    remaining: number;
    run: (id: string) => Promise<void>;
  } | null = null;

  /** A store whose reads can let another server's request run in between, as during an update. */
  class InterleavedStore extends UploadStore {
    override async getUpload(id: string) {
      const read = await super.getUpload(id);
      if (interleave && --interleave.remaining === 0) {
        const { run } = interleave;
        interleave = null;
        await run(id);
      }
      return read;
    }
  }

  const send = (
    method: string,
    url: string,
    headers: Record<string, string> = {},
    body?: string,
  ) =>
    server.handleWeb(
      new Request(url, {
        method,
        headers: { "Tus-Resumable": "1.0.0", ...headers },
        body,
      }),
    );

  beforeEach(async () => {
    previousRoot = process.env.NIMBUS_DATA_ROOT;
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-upload-server-"));
    process.env.NIMBUS_DATA_ROOT = root;
    await mkdir(path.join(root, ".nimbus/uploads"), { recursive: true });
    await mkdir(path.join(root, "docs"));
    const memory = createTestDriveStore();
    server = createUploadServer({
      store: new InterleavedStore({
        directory: path.join(root, ".nimbus/uploads"),
      }),
      drive: memory.store,
      access: () => getAccess(memory.store, "user-1"),
      fail: (error) => ({
        status_code: isApiError(error, "NOT_FOUND") ? 404 : 500,
        body: error instanceof Error ? error.message : "failed",
      }),
    });
  });
  afterEach(async () => {
    forgetFileMutationsForTest(root);
    await rm(root, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
    else process.env.NIMBUS_DATA_ROOT = previousRoot;
  });

  // tus-js-client sends the drive root's empty path as "targetPath " with no value.
  it("uploads a file and a folder to the drive root", async () => {
    const file = await send(
      "POST",
      "http://localhost/api/upload",
      {
        "Upload-Length": "2",
        "Upload-Metadata": `filename ${base64("root.txt")},targetPath ,conflict ${base64("keep-both")}`,
        "Content-Type": "application/offset+octet-stream",
      },
      "hi",
    );
    expect(file.status).toBe(201);
    expect(await readFile(path.join(root, "root.txt"), "utf8")).toBe("hi");
    const folder = await send(
      "POST",
      "http://localhost/api/upload",
      {
        "Upload-Length": "2",
        "Upload-Metadata": `filename ${base64("inside.txt")},targetPath ,folder ${base64("dropped/deeper")},conflict ${base64("keep-both")}`,
        "Content-Type": "application/offset+octet-stream",
      },
      "ok",
    );
    expect(folder.status).toBe(201);
    expect(
      await readFile(path.join(root, "dropped/deeper/inside.txt"), "utf8"),
    ).toBe("ok");
  });

  it("accepts metadata keys sent without a value, as tus-js-client sends empty strings", async () => {
    const created = await send(
      "POST",
      "http://localhost/api/upload",
      {
        "Upload-Length": "2",
        "Upload-Metadata": `filename ${base64("b.txt")},targetPath ${base64("docs")},folder,conflict ${base64("keep-both")}`,
        "Content-Type": "application/offset+octet-stream",
      },
      "hi",
    );
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
    if (!location)
      throw new Error("The tus server did not return an upload location.");
    const url = new URL(location, "http://localhost/api/upload/").href;

    // The destination disappears while the bytes arrive, so publishing fails after a full transfer.
    await rm(path.join(root, "docs"), { recursive: true });
    const patched = await send(
      "PATCH",
      url,
      {
        "Upload-Offset": "0",
        "Content-Type": "application/offset+octet-stream",
      },
      "hello",
    );
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

  it("never reports a complete upload that is not published, though another server finishes its bytes during HEAD", async () => {
    const created = await send("POST", "http://localhost/api/upload", {
      "Upload-Length": "5",
      "Upload-Metadata": `filename ${base64("late.txt")},targetPath ${base64("docs")}`,
    });
    const location = created.headers.get("location");
    if (!location)
      throw new Error("The tus server did not return an upload location.");
    const url = new URL(location, "http://localhost/api/upload/").href;
    const patched = await send(
      "PATCH",
      url,
      {
        "Upload-Offset": "0",
        "Content-Type": "application/offset+octet-stream",
      },
      "hel",
    );
    expect(patched.status).toBe(204);

    // Right after HEAD's recovery has read the upload (its second read, after the owner
    // check), a PATCH on the server being replaced writes the last bytes under the upload's
    // lock, and that server stops before it publishes.
    let lastBytes: Promise<void> = Promise.resolve();
    interleave = {
      remaining: 2,
      run: async (staged) => {
        lastBytes = UploadLocks.hold(staged, async () => {
          await server.datastore.write(
            Readable.from([Buffer.from("lo")]),
            staged,
            3,
          );
        });
        await Bun.sleep(50);
      },
    };
    const resumed = await send("HEAD", url);
    await lastBytes;
    expect(resumed.status).toBe(200);
    // HEAD decided on 3 bytes under the lock and the client sends the rest again, or it saw
    // all 5 and published them first: never 5 with nothing in the drive.
    expect(resumed.headers.get("upload-offset")).toBe("3");
    const again = await send("HEAD", url);
    expect(again.headers.get("upload-offset")).toBe("5");
    expect(await readFile(path.join(root, "docs/late.txt"), "utf8")).toBe(
      "hello",
    );
  });
});
