import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { PdfPages } from "@/lib/pdf-pages";
import { DriveFile } from "@nimbus/api/drive-file";
import { hookFileHandle } from "./file-handle-testing";
import {
  PdfChanged,
  PdfRender,
  PdfRenderFailed,
  type OpenedPdf,
} from "./pdf-render";

const poppler =
  Bun.which("pdfinfo") !== null &&
  Bun.which("pdftoppm") !== null &&
  Bun.which("prlimit") !== null;
const signal = () => new AbortController().signal;

/** A PDF of 400×200pt pages filled with a colour each; `rotate` turns a page a quarter. */
function pdf(pages: { fill: string; rotate?: number }[]) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  ];
  for (const [index, page] of pages.entries()) {
    const content = `${page.fill} rg 0 0 400 200 re f`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Rotate ${page.rotate ?? 0} /Contents ${4 + index * 2} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  }
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

describe("PdfRender.parseInfo", () => {
  test("reads the page count and each page's shown size", () => {
    expect(
      PdfRender.parseInfo(
        [
          "Producer:        test",
          "Pages:           2",
          "Encrypted:       no",
          "Page    1 size:  612 x 792 pts (letter)",
          "Page    1 rot:   0",
          "Page    2 size:  612 x 792 pts (letter)",
          "Page    2 rot:   270",
          "File size:       1000 bytes",
        ].join("\n"),
      ),
    ).toEqual({
      count: 2,
      sizes: [
        { width: 612, height: 792 },
        { width: 792, height: 612 },
      ],
    });
  });

  test("ignores page lines a document's title imitates", () => {
    expect(
      PdfRender.parseInfo(
        [
          "Title:           Pages:           9",
          "Page    1 size:  1 x 9999 pts",
          "Pages:           9",
          "Page    1 size:  1 x 9999 pts",
          "Pages:           1",
          "Page    1 size:  400 x 200 pts",
          "Page    1 rot:   0",
        ].join("\n"),
      ),
    ).toEqual({ count: 1, sizes: [{ width: 400, height: 200 }] });
  });

  test("lays out at most the first pages, sizing ones it was not told about as Letter", () => {
    const parsed = PdfRender.parseInfo(
      `Pages:           ${PdfPages.maxPages + 5}\nPage    1 size:  400 x 200 pts\n`,
    );
    expect(parsed?.count).toBe(PdfPages.maxPages + 5);
    expect(parsed?.sizes).toHaveLength(PdfPages.maxPages);
    expect(parsed?.sizes[1]).toEqual({ width: 612, height: 792 });
  });

  test("is null without a page count", () => {
    expect(PdfRender.parseInfo("Command Line Error: Incorrect password")).toBe(
      null,
    );
    expect(PdfRender.parseInfo("Pages:           0")).toBe(null);
  });
});

describe.skipIf(!poppler)("PdfRender (requires poppler-utils)", () => {
  let drive: string;
  const previousRoot = process.env.NIMBUS_DATA_ROOT;
  beforeAll(async () => {
    drive = await mkdtemp(path.join(os.tmpdir(), "nimbus-pdf-render-"));
    // The renderer opens files through the drive's checked descriptors.
    process.env.NIMBUS_DATA_ROOT = drive;
    await mkdir(path.join(drive, "docs"));
    await writeFile(
      path.join(drive, "docs/two.pdf"),
      pdf([{ fill: "0.2 0.4 0.8" }, { fill: "0.8 0.2 0.2", rotate: 90 }]),
    );
    await writeFile(path.join(drive, "docs/fake.pdf"), "not a pdf");
  });
  afterAll(async () => {
    if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
    else process.env.NIMBUS_DATA_ROOT = previousRoot;
    await rm(drive, { recursive: true, force: true });
  });

  /** Runs `run` with `name` opened as the route opens it, then closes it. */
  async function withOpened<T>(
    name: string,
    run: (file: OpenedPdf) => Promise<T>,
  ) {
    const file = await DriveFile.openFile(path.join(drive, "docs", name));
    try {
      return await run(file);
    } finally {
      await file.handle.close();
    }
  }

  test("lists pages with their rotation applied", async () => {
    expect(
      await withOpened("two.pdf", (file) => PdfRender.info(file, signal())),
    ).toEqual({
      count: 2,
      sizes: [
        { width: 400, height: 200 },
        { width: 200, height: 400 },
      ],
    });
  });

  test("renders one page as a JPEG image of the asked width", async () => {
    const image = await withOpened("two.pdf", (file) =>
      PdfRender.page(file, 2, 480, signal()),
    );
    expect((await sharp(image).metadata()).format).toBe("jpeg");
    const { data, info } = await sharp(image)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 480, height: 960 });
    // The second page's red, not the first page's blue.
    expect(
      [...data.subarray(0, 3)].map((value) => Math.round(value / 10)),
    ).toEqual([20, 5, 5]);
  });

  test("reports a page past the end and input that is not a PDF as render failures", async () => {
    await expect(
      withOpened("two.pdf", (file) => PdfRender.page(file, 3, 480, signal())),
    ).rejects.toBeInstanceOf(PdfRenderFailed);
    await expect(
      withOpened("fake.pdf", (file) => PdfRender.info(file, signal())),
    ).rejects.toBeInstanceOf(PdfRenderFailed);
  });

  test("never answers for the opened version once another file is renamed over its path", async () => {
    const target = path.join(drive, "docs/swapped.pdf");
    await writeFile(target, pdf([{ fill: "0.2 0.4 0.8" }]));
    // The opened file is unlinked, which moves its change time: refused rather than answered
    // under a version the path no longer holds.
    await expect(
      withOpened("swapped.pdf", async (file) => {
        await writeFile(
          `${target}.next`,
          pdf([{ fill: "0.8 0.2 0.2" }, { fill: "0.8 0.2 0.2" }]),
        );
        await rename(`${target}.next`, target);
        return PdfRender.info(file, signal());
      }),
    ).rejects.toBeInstanceOf(PdfChanged);
  });

  test("answers a request that left after the final check of its file with its abort, not the pages", async () => {
    const controller = new AbortController();
    const result = withOpened("two.pdf", async (file) => {
      // The request goes away just as the renderer's last step, stating the file, finishes.
      const restore = await hookFileHandle("stat", "after", 1, () =>
        controller.abort(),
      );
      try {
        return await PdfRender.info(file, controller.signal);
      } finally {
        restore();
      }
    });
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });

  test("refuses output when the opened file was rewritten with its old size and modification time", async () => {
    const target = path.join(drive, "docs/disguised.pdf");
    const blue = pdf([{ fill: "0.2 0.4 0.8" }]);
    const red = pdf([{ fill: "0.8 0.2 0.2" }]);
    expect(red.length).toBe(blue.length);
    await writeFile(target, blue);
    const when = new Date(1_700_000_000_000);
    await utimes(target, when, when);
    await expect(
      withOpened("disguised.pdf", async (file) => {
        await writeFile(target, red);
        await utimes(target, when, when);
        return PdfRender.page(file, 1, 480, signal());
      }),
    ).rejects.toBeInstanceOf(PdfChanged);
  });

  test("refuses output when the opened file was written in place", async () => {
    const target = path.join(drive, "docs/rewritten.pdf");
    await writeFile(target, pdf([{ fill: "0.2 0.4 0.8" }]));
    await expect(
      withOpened("rewritten.pdf", async (file) => {
        await writeFile(
          target,
          pdf([{ fill: "0.8 0.2 0.2" }, { fill: "0.8 0.2 0.2" }]),
        );
        return PdfRender.page(file, 1, 480, signal());
      }),
    ).rejects.toBeInstanceOf(PdfChanged);
  });
});
