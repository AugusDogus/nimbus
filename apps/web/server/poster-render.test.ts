import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { PosterRender } from "./poster-render";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nimbus-poster-render-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The source size of the image at `file`, drawn through a freshly opened descriptor. */
async function drawn(file: string) {
  const handle = await open(file, "r");
  try {
    const result = await PosterRender.master(
      "image",
      { handle, stats: await handle.stat() },
      new AbortController().signal,
    );
    if (result.kind !== "ready") throw new Error(`not drawn: ${result.kind}`);
    return { fd: handle.fd, source: result.master.source };
  } finally {
    await handle.close();
  }
}

test("a descriptor number reused for another file draws that file, not the earlier one", async () => {
  const first = path.join(root, "first.tif");
  const second = path.join(root, "second.tif");
  for (const [file, width, height] of [
    [first, 300, 200],
    [second, 500, 100],
  ] as const)
    await sharp({
      create: { width, height, channels: 3, background: "#806040" },
    })
      .tiff({ tile: true })
      .toFile(file);
  const a = await drawn(first);
  const b = await drawn(second);
  // The same /proc name both times: only libvips' cache could confuse them.
  expect(b.fd).toBe(a.fd);
  expect(a.source).toEqual({ width: 300, height: 200 });
  expect(b.source).toEqual({ width: 500, height: 100 });
});
