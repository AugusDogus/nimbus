import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DriveFile } from "@nimbus/api/drive-file";
import type { ArchiveEntry } from "./routes/archive-entries";
import { zipStream } from "./zip-stream";

let root: string;
let previousRoot: string | undefined;
beforeEach(async () => {
  previousRoot = process.env.NIMBUS_DATA_ROOT;
  root = await mkdtemp(path.join(os.tmpdir(), "nimbus-zip-"));
  process.env.NIMBUS_DATA_ROOT = root;
});
afterEach(async () => {
  if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
  else process.env.NIMBUS_DATA_ROOT = previousRoot;
  await rm(root, { recursive: true, force: true });
});

async function* listed(...entries: ArchiveEntry[]) {
  yield* entries;
}

const file = (
  name: string,
  size: number,
  authorize: () => Promise<void> = async () => undefined,
): ArchiveEntry => ({
  type: "file",
  name,
  absolute: path.join(root, name),
  size,
  mtime: new Date(),
  authorize,
});

test("a ZIP fails its download, not the server, when a listed file is gone before it is read", async () => {
  await writeFile(path.join(root, "kept.txt"), "kept");
  const body = zipStream(
    listed(file("kept.txt", 4), file("deleted-meanwhile.txt", 3)),
    null,
    "a folder",
  );
  await expect(new Response(body).arrayBuffer()).rejects.toThrow(
    "no longer exists",
  );
});

test("a ZIP fails its download, not the server, when a listed file changed size before it is read", async () => {
  // Listed at 10 bytes, then rewritten shorter by another program.
  await writeFile(path.join(root, "shrunk.txt"), "abc");
  const body = zipStream(listed(file("shrunk.txt", 10)), null, "a folder");
  await expect(new Response(body).arrayBuffer()).rejects.toThrow(
    "unexpected number of bytes",
  );
});

test("a ZIP fails its download, not the server, when reading a listed file fails partway", async () => {
  const size = 4 << 20;
  await writeFile(path.join(root, "failing.bin"), Buffer.alloc(size));
  const openFile = DriveFile.openFile;
  // The disk fails once the file is being read, as an I/O error would.
  const spy = spyOn(DriveFile, "openFile").mockImplementation(
    async (absolute) => {
      const opened = await openFile(absolute);
      const createReadStream = opened.handle.createReadStream.bind(
        opened.handle,
      );
      opened.handle.createReadStream = (options) => {
        const stream = createReadStream(options);
        stream.once("data", () =>
          stream.destroy(
            Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" }),
          ),
        );
        return stream;
      };
      return opened;
    },
  );
  try {
    const body = zipStream(listed(file("failing.bin", size)), null, "a folder");
    await expect(new Response(body).arrayBuffer()).rejects.toThrow("EIO");
  } finally {
    spy.mockRestore();
  }
});

test("a ZIP checks each file's access again when it opens it, not only when it was listed", async () => {
  await writeFile(path.join(root, "first.txt"), "first");
  await writeFile(path.join(root, "second.txt"), "secret-content");
  // Every entry is listed long before yazl opens it; access ends after the first file is read.
  let allowed = true;
  const opened: string[] = [];
  const authorize = (name: string) => async () => {
    if (!allowed) throw new Error("The link no longer grants this download.");
    opened.push(name);
    allowed = false;
  };
  const body = zipStream(
    listed(
      file("first.txt", 5, authorize("first.txt")),
      file("second.txt", 14, authorize("second.txt")),
    ),
    null,
    "a folder",
  );
  await expect(new Response(body).arrayBuffer()).rejects.toThrow(
    "no longer grants",
  );
  expect(opened).toEqual(["first.txt"]);
});
