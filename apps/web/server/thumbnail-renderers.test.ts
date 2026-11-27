import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { pdfRenderer, runBounded, videoRenderer } from "./thumbnail-renderers";
import { fromVerifiedFile } from "./thumbnail-service";
import { ThumbnailTimeout } from "./thumbnails";

const pdftoppm = Bun.which("pdftoppm");
const ffmpeg = Bun.which("ffmpeg");
const signal = () => new AbortController().signal;
let root: string;

/** A one-page 400×200pt PDF with a filled rectangle. */
function pdf() {
  const content = "0.2 0.4 0.8 rg 20 20 360 160 re f";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  return `${body}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nimbus-renderers-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("runBounded", () => {
  test("kills a process at its deadline", async () => {
    const started = performance.now();
    await expect(
      runBounded(
        ["sleep", "5"],
        {
          timeoutMs: 200,
          memoryBytes: 2 ** 28,
          cpuSeconds: 1,
          maxOutputBytes: 10,
        },
        signal(),
      ),
    ).rejects.toBeInstanceOf(ThumbnailTimeout);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("rejects output beyond the cap", async () => {
    await expect(
      runBounded(
        ["yes"],
        {
          timeoutMs: 2_000,
          memoryBytes: 2 ** 28,
          cpuSeconds: 1,
          maxOutputBytes: 1024,
        },
        signal(),
      ),
    ).rejects.toThrow(/yes exited/);
  });

  test("stops when the requester aborts", async () => {
    const controller = new AbortController();
    const running = runBounded(
      ["sleep", "5"],
      {
        timeoutMs: 5_000,
        memoryBytes: 2 ** 28,
        cpuSeconds: 1,
        maxOutputBytes: 10,
      },
      controller.signal,
    );
    controller.abort();
    await expect(running).rejects.toBeDefined();
  });
});

describe.skipIf(!pdftoppm)("PDF thumbnails (requires pdftoppm)", () => {
  test("a decoder process reads the file through a descriptor opened without following symlinks", async () => {
    const previousRoot = process.env.NIMBUS_DATA_ROOT;
    const drive = path.join(root, "drive");
    process.env.NIMBUS_DATA_ROOT = drive;
    try {
      await mkdir(path.join(drive, "docs"), { recursive: true });
      await writeFile(path.join(drive, "docs/page.pdf"), pdf());
      // A folder swapped for a symlink after its path was checked.
      await symlink(path.join(drive, "docs"), path.join(drive, "swapped"));
      const render = fromVerifiedFile(pdfRenderer(pdftoppm ?? ""));
      const output = await render(path.join(drive, "docs/page.pdf"), signal());
      expect(await sharp(output).metadata()).toMatchObject({ format: "webp" });
      await expect(
        render(path.join(drive, "swapped/page.pdf"), signal()),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
      else process.env.NIMBUS_DATA_ROOT = previousRoot;
    }
  });

  test("renders the first page within the thumbnail size", async () => {
    const file = path.join(root, "page.pdf");
    await writeFile(file, pdf());
    const output = await pdfRenderer(pdftoppm ?? "")(file, signal());
    expect(await sharp(output).metadata()).toMatchObject({
      format: "webp",
      width: 256,
      height: 128,
    });
  });

  test("fails on input that is not a PDF", async () => {
    const file = path.join(root, "fake.pdf");
    await writeFile(file, "not a pdf");
    await expect(pdfRenderer(pdftoppm ?? "")(file, signal())).rejects.toThrow();
  });
});

describe.skipIf(!ffmpeg)("video thumbnails (requires ffmpeg)", () => {
  for (const [name, codec] of [
    ["clip.mp4", "mpeg4"],
    ["short.webm", "libvpx-vp9"],
  ] as const)
    test(`extracts a frame from ${name}`, async () => {
      const file = path.join(root, name);
      const duration = name.startsWith("short") ? "0.4" : "2";
      const made = Bun.spawnSync([
        ffmpeg ?? "",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `testsrc=size=640x360:rate=10:duration=${duration}`,
        "-c:v",
        codec,
        "-y",
        file,
      ]);
      expect(made.exitCode).toBe(0);
      const output = sharp(await videoRenderer(ffmpeg ?? "")(file, signal()));
      // The frame's own shape, with no letterboxing: a preview sizes its poster from it.
      expect(await output.metadata()).toMatchObject({
        format: "webp",
        width: 256,
        height: 144,
      });
      const { data } = await output
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(data[3]).toBe(255);
      expect(data[data.byteLength - 1]).toBe(255);
    });

  // Shown as a player shows them: stretched by their pixel shape, turned by their rotation.
  for (const [name, input, output, size] of [
    [
      "anamorphic.mp4",
      ["-vf", "setsar=64/45"],
      [],
      { width: 256, height: 144 },
    ],
    [
      "rotated.mp4",
      [],
      ["-display_rotation", "90"],
      { width: 144, height: 256 },
    ],
  ] as const)
    test(`keeps the displayed shape of ${name}`, async () => {
      const plain = path.join(root, `plain-${name}`);
      const file = path.join(root, name);
      const run = (args: readonly string[]) =>
        Bun.spawnSync([ffmpeg ?? "", "-v", "error", "-y", ...args]).exitCode;
      expect(
        run([
          "-f",
          "lavfi",
          "-i",
          `testsrc=size=${name === "anamorphic.mp4" ? "720x576" : "640x360"}:rate=10:duration=2`,
          ...input,
          "-c:v",
          "mpeg4",
          plain,
        ]),
      ).toBe(0);
      expect(run([...output, "-i", plain, "-c", "copy", file])).toBe(0);
      expect(
        await sharp(
          await videoRenderer(ffmpeg ?? "")(file, signal()),
        ).metadata(),
      ).toMatchObject(size);
    });

  test("fails on input that is not a video", async () => {
    const file = path.join(root, "fake.mp4");
    await writeFile(file, "not a video");
    await expect(videoRenderer(ffmpeg ?? "")(file, signal())).rejects.toThrow();
  });
});
