import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type BrowserContext, type Locator } from "@playwright/test";
import sharp from "sharp";
import { z } from "zod";
import { client, port, test } from "./helpers";

async function dataRoot() {
  const manifest: unknown = JSON.parse(
    await readFile(path.join(os.tmpdir(), `nimbus-e2e-${port}.json`), "utf8"),
  );
  return z
    .object({ dataRoot: z.string().startsWith(os.tmpdir()) })
    .parse(manifest).dataRoot;
}

// The headless shell has no PDF viewer; full Chromium in its new headless mode does.
test.use({ channel: "chromium" });

/**
 * Make the page's browser report no PDF viewer, as Chrome on Android does. Such a browser turns
 * a framed PDF into a download prompt; under the page's `frame-src 'self'` Chrome then shows
 * "This content is blocked" in the frame.
 */
async function withoutPdfViewer(context: BrowserContext) {
  await context.addInitScript(() =>
    Object.defineProperty(Navigator.prototype, "pdfViewerEnabled", {
      get: () => false,
    }),
  );
}

async function pdfFolder(context: BrowserContext, pages: number) {
  const folder = `pdf-${randomUUID()}`;
  const rpc = await client(context);
  await rpc.files.createFolder.mutate({ name: folder });
  await writeFile(path.join(await dataRoot(), folder, "page.pdf"), pdf(pages));
  return { folder, rpc };
}

/** A PDF of 400×200pt pages, each with a filled rectangle. */
function pdf(pages = 1) {
  const content = "0.2 0.4 0.8 rg 20 20 360 160 re f";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, index) => `${4 + index} 0 R`).join(" ")}] /Count ${pages} >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ...Array.from(
      { length: pages },
      () =>
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Contents 3 0 R >>",
    ),
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

/** The PDF's fill colour, 0.2 0.4 0.8 in RGB. */
const fill = { r: 51, g: 102, b: 204 };

/**
 * Pixels of the PDF's rectangle visible in `frame`, from a screenshot of the element. This
 * checks what the visitor sees, not the viewer's internal markup, which Chromium builds
 * lazily and changes between versions.
 */
async function filledPixels(frame: Locator) {
  const { data, info } = await sharp(await frame.screenshot())
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let index = 0; index < data.length; index += info.channels)
    if (
      Math.abs((data[index] ?? 0) - fill.r) < 24 &&
      Math.abs((data[index + 1] ?? 0) - fill.g) < 24 &&
      Math.abs((data[index + 2] ?? 0) - fill.b) < 24
    )
      count++;
  return count;
}

test("PDF previews render in Chromium although served sandboxed", async ({
  page,
  context,
  isMobile,
}) => {
  test.skip(isMobile, "The preview frame is the same on mobile.");
  const { folder } = await pdfFolder(context, 1);
  // The preview response is sandboxed, which must not stop Chromium's viewer.
  const served = await context.request.get(
    `/api/files/download?preview=1&path=${encodeURIComponent(`${folder}/page.pdf`)}`,
  );
  expect(served.headers()["content-type"]).toBe("application/pdf");
  expect(served.headers()["content-security-policy"]).toContain("sandbox");
  await page.goto(`/browse/${folder}`);
  await page
    .locator('[data-entry-name="page.pdf"]')
    .filter({ visible: true })
    .click();
  const preview = page.getByRole("dialog", { name: "page.pdf", exact: true });
  await expect(preview).toBeVisible();
  // The rectangle covers about 100,000 pixels once drawn. The viewer starts a renderer
  // process first, which takes longer on a busy machine.
  await expect
    .poll(() => filledPixels(preview.locator("iframe")), { timeout: 60_000 })
    .toBeGreaterThan(10_000);
});

test("PDF previews show the server's page images where the browser has no PDF viewer", async ({
  page,
  context,
}) => {
  await withoutPdfViewer(context);
  const { folder } = await pdfFolder(context, 3);
  await page.goto(`/browse/${folder}`);
  await page
    .locator('[data-entry-name="page.pdf"]')
    .filter({ visible: true })
    .click();
  const preview = page.getByRole("dialog", { name: "page.pdf", exact: true });
  const pages = preview.getByRole("region", { name: "Pages of page.pdf" });
  await expect(pages).toBeVisible();
  // No frame: it would show Chrome's download prompt, blocked by the page's policy.
  await expect(preview.locator("iframe")).toHaveCount(0);
  const first = pages.getByRole("img", { name: "Page 1 of 3", exact: true });
  await expect
    .poll(() => first.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  await expect.poll(() => filledPixels(first)).toBeGreaterThan(10_000);
  // Later pages load as they scroll into view.
  const last = pages.getByRole("img", { name: "Page 3 of 3", exact: true });
  await last.scrollIntoViewIfNeeded();
  await expect
    .poll(() => last.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  await expect(
    preview.getByRole("link", { name: "Open in a new tab" }),
  ).toHaveAttribute("href", /preview=1/);
});

test("a public link's PDF shows page images to a visitor without a PDF viewer", async ({
  context,
  browser,
}) => {
  const { folder, rpc } = await pdfFolder(context, 2);
  const { token } = await rpc.shares.create.mutate({
    path: `${folder}/page.pdf`,
    expiresAt: null,
  });
  const visitor = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  try {
    await withoutPdfViewer(visitor);
    const page = await visitor.newPage();
    const violations: string[] = [];
    page.on("console", (message) => {
      if (message.text().includes("Content Security Policy"))
        violations.push(message.text());
    });
    await page.goto(`/s/${token}`);
    const pages = page.getByRole("region", { name: "Pages of page.pdf" });
    const first = pages.getByRole("img", { name: "Page 1 of 2", exact: true });
    await expect
      .poll(() =>
        first.evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);
    await expect.poll(() => filledPixels(first)).toBeGreaterThan(10_000);
    await expect(page.locator("iframe")).toHaveCount(0);
    expect(violations).toEqual([]);
  } finally {
    await visitor.close();
  }
});

test("PDF page endpoints check access, and a link's pages continue its counted view", async ({
  context,
  browser,
}) => {
  const { folder, rpc } = await pdfFolder(context, 2);
  const signedIn = `/api/files/pdf?path=${encodeURIComponent(`${folder}/page.pdf`)}`;
  const listed = await context.request.get(signedIn);
  expect(listed.status()).toBe(200);
  const pages = z
    .object({
      count: z.number(),
      sizes: z.array(z.object({ width: z.number(), height: z.number() })),
      version: z.string(),
    })
    .parse(await listed.json());
  expect(pages).toMatchObject({
    count: 2,
    sizes: [
      { width: 400, height: 200 },
      { width: 400, height: 200 },
    ],
  });
  const image = await context.request.get(
    `${signedIn}&v=${pages.version}&page=2&width=480`,
  );
  expect(image.status()).toBe(200);
  expect(image.headers()["content-type"]).toBe("image/jpeg");
  expect(image.headers()["content-security-policy"]).toContain("sandbox");
  expect(await sharp(await image.body()).metadata()).toMatchObject({
    width: 480,
    height: 240,
  });
  expect(
    (
      await context.request.get(`${signedIn}&page=2&width=480`, {
        headers: { "If-None-Match": image.headers()["etag"] ?? "" },
      })
    ).status(),
  ).toBe(304);
  // Only the fixed widths and pages in range are rendered.
  for (const query of ["&page=1&width=500", "&page=0&width=480", "&page=1"])
    expect((await context.request.get(`${signedIn}${query}`)).status()).toBe(
      400,
    );
  await writeFile(path.join(await dataRoot(), folder, "notes.txt"), "text");
  expect(
    (
      await context.request.get(
        `/api/files/pdf?path=${encodeURIComponent(`${folder}/notes.txt`)}`,
      )
    ).status(),
  ).toBe(415);

  const visitor = () =>
    browser.newContext({ storageState: { cookies: [], origins: [] } });
  const first = await visitor();
  const second = await visitor();
  try {
    expect((await first.request.get(signedIn)).status()).toBe(401);
    const { token } = await rpc.shares.create.mutate({
      path: folder,
      expiresAt: null,
      maxDownloads: 1,
    });
    const shared = `/api/share/${token}/pdf?path=page.pdf`;
    // Pages are never served to a browser that has not opened the PDF: they would be a free copy.
    expect(
      (await first.request.get(`${shared}&page=1&width=480`)).status(),
    ).toBe(403);
    // Opening the PDF uses up the link's one download; its pages and reopening it do not.
    expect((await first.request.get(shared)).status()).toBe(200);
    for (const page of [1, 2])
      expect(
        (await first.request.get(`${shared}&page=${page}&width=480`)).status(),
      ).toBe(200);
    expect((await first.request.get(shared)).status()).toBe(200);
    expect((await second.request.get(shared)).status()).toBe(404);
    expect(
      (await second.request.get(`${shared}&page=1&width=480`)).status(),
    ).toBe(403);
    expect(
      (
        await first.request.get(
          `/api/share/${token}/pdf?path=${encodeURIComponent("../outside.pdf")}`,
        )
      ).status(),
    ).toBeGreaterThanOrEqual(400);
  } finally {
    await first.close();
    await second.close();
  }
});
