import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { FileKind } from "@/lib/file-kind";
import { createThumbnailer, imageRenderer, thumbnailTag, type ThumbnailSource } from "./thumbnails";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nimbus-thumbnails-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const source = (name: string, mtimeMs = 1): ThumbnailSource => ({
  absolute: path.join(root, name),
  relative: name,
  size: 10,
  mtimeMs,
  kind: FileKind.of(name),
});
const webp = new Uint8Array([1, 2, 3]);
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const deferred = () => {
  let resolve: (body: Uint8Array) => void = () => {};
  const promise = new Promise<Uint8Array>((done) => (resolve = done));
  return { promise, resolve };
};

test("tags change when the path, modification time or size change", () => {
  const a = source("a.png");
  expect(thumbnailTag(a)).toBe(thumbnailTag(source("a.png")));
  expect(thumbnailTag(a)).not.toBe(thumbnailTag(source("a.png", 2)));
  expect(thumbnailTag(a)).not.toBe(thumbnailTag({ ...a, size: 11 }));
  expect(thumbnailTag(a)).not.toBe(thumbnailTag(source("b.png")));
});

test("renders once, then serves the cached file", async () => {
  let renders = 0;
  const thumbnails = createThumbnailer({
    cacheDirectory: path.join(root, "cache"),
    renderers: { image: async () => (renders++, webp) },
  });
  const signal = new AbortController().signal;
  expect(await thumbnails.get(source("a.png"), signal)).toEqual({ type: "ready", body: webp });
  expect(await thumbnails.get(source("a.png"), signal)).toEqual({ type: "ready", body: webp });
  expect(renders).toBe(1);
  expect((await readdir(path.join(root, "cache"))).every((name) => name.endsWith(".webp"))).toBe(true);
});

test("shares one render between concurrent requests for the same file", async () => {
  const render = deferred();
  let renders = 0;
  const thumbnails = createThumbnailer({
    cacheDirectory: path.join(root, "cache"),
    renderers: { image: () => (renders++, render.promise) },
  });
  const signal = new AbortController().signal;
  const results = Promise.all([thumbnails.get(source("a.png"), signal), thumbnails.get(source("a.png"), signal)]);
  render.resolve(webp);
  expect((await results).map((result) => result.type)).toEqual(["ready", "ready"]);
  expect(renders).toBe(1);
});

test("bounds concurrent renders and rejects work beyond the queue limit", async () => {
  const renders = [deferred(), deferred(), deferred()];
  let running = 0;
  let peak = 0;
  const thumbnails = createThumbnailer({
    cacheDirectory: path.join(root, "cache"),
    concurrency: 1,
    maxQueued: 1,
    renderers: {
      image: async (absolute) => {
        running++;
        peak = Math.max(peak, running);
        const body = await renders[Number(path.basename(absolute)[0])].promise;
        running--;
        return body;
      },
    },
  });
  const signal = new AbortController().signal;
  const first = thumbnails.get(source("0.png"), signal);
  await tick();
  const second = thumbnails.get(source("1.png"), signal);
  await tick();
  await expect(thumbnails.get(source("2.png"), signal)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  renders[0].resolve(webp);
  renders[1].resolve(webp);
  expect((await first).type).toBe("ready");
  expect((await second).type).toBe("ready");
  expect(peak).toBe(1);
});

test("drops queued work when every requester has gone away", async () => {
  const blocker = deferred();
  const rendered: string[] = [];
  const thumbnails = createThumbnailer({
    cacheDirectory: path.join(root, "cache"),
    concurrency: 1,
    renderers: {
      image: async (absolute) => {
        rendered.push(path.basename(absolute));
        return absolute.endsWith("0.png") ? blocker.promise : webp;
      },
    },
  });
  const first = thumbnails.get(source("0.png"), new AbortController().signal);
  await tick();
  const leaving = new AbortController();
  const abandoned = thumbnails.get(source("1.png"), leaving.signal);
  await tick();
  leaving.abort();
  await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
  blocker.resolve(webp);
  await first;
  expect(rendered).toEqual(["0.png"]);
});

test("remembers files that cannot be rendered until they change", async () => {
  let renders = 0;
  const thumbnails = createThumbnailer({
    cacheDirectory: path.join(root, "cache"),
    renderers: {
      image: async () => {
        renders++;
        throw new Error("corrupt input");
      },
    },
  });
  const signal = new AbortController().signal;
  expect(await thumbnails.get(source("a.png"), signal)).toEqual({ type: "unavailable" });
  expect(await thumbnails.get(source("a.png"), signal)).toEqual({ type: "unavailable" });
  expect(renders).toBe(1);
  expect(await thumbnails.get(source("a.png", 2), signal)).toEqual({ type: "unavailable" });
  expect(renders).toBe(2);
});

test("reports kinds without an installed renderer as unavailable", async () => {
  const thumbnails = createThumbnailer({ cacheDirectory: path.join(root, "cache"), renderers: {} });
  expect(await thumbnails.get(source("a.pdf"), new AbortController().signal)).toEqual({ type: "unavailable" });
});

test("the image renderer fits, orients and bounds input pixels", async () => {
  const photo = path.join(root, "photo.png");
  await sharp({ create: { width: 1200, height: 600, channels: 3, background: "#3366ff" } }).png().toFile(photo);
  const output = sharp(await imageRenderer(photo, new AbortController().signal));
  expect(await output.metadata()).toMatchObject({ format: "webp", width: 256, height: 128 });
  const huge = path.join(root, "huge.png");
  await writeFile(huge, await sharp({ create: { width: 10_000, height: 5_000, channels: 3, background: "#000" } }).png().toBuffer());
  await expect(imageRenderer(huge, new AbortController().signal)).rejects.toThrow(/pixel limit/);
});
