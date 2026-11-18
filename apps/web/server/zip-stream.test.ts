import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

const file = (name: string, size: number): ArchiveEntry => ({
  type: "file",
  name,
  absolute: path.join(root, name),
  size,
  mtime: new Date(),
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
