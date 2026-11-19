import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
} from "@playwright/test";
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

/** A PDF of 400×200pt pages, each drawn by `content`: by default a filled blue rectangle. */
function pdf(pages = 1, content = "0.2 0.4 0.8 rg 20 20 360 160 re f") {
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

/** A browser with no cookies, as a visitor following a public link. */
const visitorOf = (browser: Browser) =>
  browser.newContext({ storageState: { cookies: [], origins: [] } });

/** The colour at the centre of an image, rounded to tens. */
async function centre(image: Buffer) {
  const { data, info } = await sharp(image)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const at =
    (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) *
    info.channels;
  return [...data.subarray(at, at + 3)].map((value) => Math.round(value / 10));
}

const red = "0.8 0.2 0.2 rg 0 0 400 200 re f";
/** The default rectangle's blue, and `red`, as `centre` reports them. */
const blueCentre = [5, 10, 20];
const redCentre = [20, 5, 5];

for (const replacement of ["renamed over it", "rewritten in place"] as const)
  test(`a page is drawn from the version its proof and ETag name, when the PDF is ${replacement} while it waits`, async ({
    context,
    browser,
  }) => {
    const { folder, rpc } = await pdfFolder(context, 1);
    const root = path.join(await dataRoot(), folder);
    // Each page of this takes Poppler about two seconds, so a few of them fill the render queue.
    let squares = "0.5 g\n";
    for (let index = 0; index < 600_000; index++)
      squares += `${(index * 7) % 390} ${(index * 13) % 190} 3 3 re f\n`;
    await writeFile(path.join(root, "slow.pdf"), pdf(1, squares));
    const { token } = await rpc.shares.create.mutate({
      path: folder,
      expiresAt: null,
    });
    const visitor = await visitorOf(browser);
    try {
      const shared = `/api/share/${token}/pdf?path=page.pdf`;
      const opened = await visitor.request.get(shared);
      expect(opened.status()).toBe(200);
      const etag = opened.headers()["etag"] ?? "";
      const slow = Array.from({ length: 12 }, () =>
        context.request.get(
          `/api/files/pdf?path=${encodeURIComponent(`${folder}/slow.pdf`)}&page=1&width=1600`,
          { timeout: 120_000 },
        ),
      );
      // Let the slow renders take every render slot, so the next request waits in the queue.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const waiting = visitor.request.get(`${shared}&page=1&width=480`, {
        timeout: 120_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (replacement === "renamed over it") {
        await writeFile(path.join(root, "next.pdf"), pdf(1, red));
        await rename(path.join(root, "next.pdf"), path.join(root, "page.pdf"));
      } else await writeFile(path.join(root, "page.pdf"), pdf(1, red));
      const page = await waiting;
      await Promise.all(slow);
      // Never the new document under the old version's proof and ETag: either the opened
      // version itself, or a refusal that asks for a reload. 409: written while drawn. 403:
      // written before this request opened it, so its proof names the old version.
      if (page.status() === 200) {
        expect(page.headers()["etag"]?.startsWith(etag.slice(0, -1))).toBe(
          true,
        );
        expect(await centre(await page.body())).toEqual(blueCentre);
      } else expect([403, 409]).toContain(page.status());
      // The new version has no proof yet: its pages need a counted view of their own.
      expect(
        (await visitor.request.get(`${shared}&page=1&width=480`)).status(),
      ).toBe(403);
      const reopened = await visitor.request.get(shared);
      expect(reopened.status()).toBe(200);
      const fresh = await visitor.request.get(`${shared}&page=1&width=480`);
      expect(await centre(await fresh.body())).toEqual(redCentre);
    } finally {
      await visitor.close();
    }
  });

test("a counted pages view lets the visitor open and download that version of the PDF without counting again", async ({
  context,
  browser,
}) => {
  const { folder, rpc } = await pdfFolder(context, 2);
  const { token } = await rpc.shares.create.mutate({
    path: `${folder}/page.pdf`,
    expiresAt: null,
    maxDownloads: 1,
  });
  const first = await visitorOf(browser);
  const second = await visitorOf(browser);
  try {
    const link = `/api/share/${token}`;
    expect((await first.request.get(`${link}/pdf?path=`)).status()).toBe(200);
    // Past the pages shown, the visitor is told to open the PDF: that must work.
    for (const query of ["preview=1", "download=1", "preview=1"]) {
      const whole = await first.request.get(`${link}?path=&${query}`);
      expect(whole.status()).toBe(200);
      expect((await whole.body()).subarray(0, 5).toString()).toBe("%PDF-");
    }
    // Another browser has no proof, and the one download is used.
    expect((await second.request.get(`${link}/pdf?path=`)).status()).toBe(404);
    expect((await second.request.get(`${link}?path=&preview=1`)).status()).toBe(
      404,
    );
    // The proof covers the version that was counted, not a later one.
    await writeFile(path.join(await dataRoot(), folder, "page.pdf"), pdf(3));
    expect((await first.request.get(`${link}?path=&preview=1`)).status()).toBe(
      404,
    );
  } finally {
    await first.close();
    await second.close();
  }
});

test("a refused PDF request never starts Poppler", async ({
  context,
  browser,
}) => {
  const { folder, rpc } = await pdfFolder(context, 1);
  // Poppler fails on this, so a request that reached it answers 422 instead of its refusal.
  await writeFile(
    path.join(await dataRoot(), folder, "broken.pdf"),
    "not a pdf",
  );
  const { token } = await rpc.shares.create.mutate({
    path: `${folder}/broken.pdf`,
    expiresAt: null,
    maxDownloads: 1,
  });
  const locked = await rpc.shares.create.mutate({
    path: `${folder}/broken.pdf`,
    expiresAt: null,
    password: "pdf-locked-pass-42",
  });
  const first = await visitorOf(browser);
  const second = await visitorOf(browser);
  try {
    expect(
      (
        await first.request.get(`/api/share/${token}?path=&download=1`)
      ).status(),
    ).toBe(200);
    for (const url of [
      `/api/share/${token}/pdf?path=`,
      `/api/share/${token}/pdf?path=&page=1&width=480`,
      `/api/share/${locked.token}/pdf?path=`,
      `/api/share/${locked.token}/pdf?path=&page=1&width=480`,
      `/api/files/pdf?path=${encodeURIComponent(`${folder}/broken.pdf`)}`,
    ])
      expect([401, 403, 404]).toContain(
        (await second.request.get(url)).status(),
      );
  } finally {
    await first.close();
    await second.close();
  }
});

test("HEAD on a link's PDF pages neither counts a download nor issues a proof", async ({
  context,
  browser,
}) => {
  const { folder, rpc } = await pdfFolder(context, 1);
  const { token } = await rpc.shares.create.mutate({
    path: `${folder}/page.pdf`,
    expiresAt: null,
    maxDownloads: 1,
  });
  const first = await visitorOf(browser);
  const second = await visitorOf(browser);
  try {
    const shared = `/api/share/${token}/pdf?path=`;
    const head = await first.request.head(shared);
    expect(head.status()).toBe(200);
    expect(head.headers()["set-cookie"]).toBeUndefined();
    expect(
      (await first.request.get(`${shared}&page=1&width=480`)).status(),
    ).toBe(403);
    expect((await second.request.get(shared)).status()).toBe(200);
    expect((await first.request.get(shared)).status()).toBe(404);
  } finally {
    await first.close();
    await second.close();
  }
});
