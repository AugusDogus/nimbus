import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { PdfPages } from "@/lib/pdf-pages";
import { PdfRender, PdfRenderFailed } from "./pdf-render";

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

  test("lists pages with their rotation applied", async () => {
    expect(
      await PdfRender.info(path.join(drive, "docs/two.pdf"), signal()),
    ).toEqual({
      count: 2,
      sizes: [
        { width: 400, height: 200 },
        { width: 200, height: 400 },
      ],
    });
  });

  test("renders one page as a JPEG image of the asked width", async () => {
    const image = await PdfRender.page(
      path.join(drive, "docs/two.pdf"),
      2,
      480,
      signal(),
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
      PdfRender.page(path.join(drive, "docs/two.pdf"), 3, 480, signal()),
    ).rejects.toBeInstanceOf(PdfRenderFailed);
    await expect(
      PdfRender.info(path.join(drive, "docs/fake.pdf"), signal()),
    ).rejects.toBeInstanceOf(PdfRenderFailed);
  });
});
