import { randomUUID } from "node:crypto";
import { rename, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
} from "@playwright/test";
import sharp from "sharp";
import { z } from "zod";
import { client, test } from "./helpers";
import { dataRoot, pdf } from "./pdf-files";

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

/**
 * Hold every render slot for several seconds with pages that take Poppler about two seconds
 * each, so the next PDF request waits in the queue. Resolves once they hold the slots; await
 * `finished` before the test ends.
 */
async function fillRenderQueue(context: BrowserContext, folder: string) {
  let squares = "0.5 g\n";
  for (let index = 0; index < 600_000; index++)
    squares += `${(index * 7) % 390} ${(index * 13) % 190} 3 3 re f\n`;
  await writeFile(
    path.join(await dataRoot(), folder, "slow.pdf"),
    pdf(1, squares),
  );
  const slow = Array.from({ length: 12 }, () =>
    context.request.get(
      `/api/files/pdf?path=${encodeURIComponent(`${folder}/slow.pdf`)}&page=1&width=1600`,
      { timeout: 120_000 },
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return { finished: Promise.all(slow) };
}
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
      const queue = await fillRenderQueue(context, folder);
      const waiting = visitor.request.get(`${shared}&page=1&width=480`, {
        timeout: 120_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (replacement === "renamed over it") {
        await writeFile(path.join(root, "next.pdf"), pdf(1, red));
        await rename(path.join(root, "next.pdf"), path.join(root, "page.pdf"));
      } else await writeFile(path.join(root, "page.pdf"), pdf(1, red));
      const page = await waiting;
      await queue.finished;
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

/** The default rectangle in red: a PDF of exactly the same size as the default one. */
const sameSizeRed = "0.8 0.2 0.2 rg 20 20 360 160 re f";

for (const replacement of ["renamed over it", "rewritten in place"] as const)
  test(`a proof does not cover a replacement ${replacement} with the same size and modification time`, async ({
    context,
    browser,
  }) => {
    const { folder, rpc } = await pdfFolder(context, 1);
    const file = path.join(await dataRoot(), folder, "page.pdf");
    // Whole seconds, so the replacement can be given exactly the same modification time.
    const when = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    await utimes(file, when, when);
    const before = await stat(file);
    const { token } = await rpc.shares.create.mutate({
      path: `${folder}/page.pdf`,
      expiresAt: null,
      maxDownloads: 1,
    });
    const visitor = await visitorOf(browser);
    try {
      const shared = `/api/share/${token}/pdf?path=`;
      expect((await visitor.request.get(shared)).status()).toBe(200);
      const first = await visitor.request.get(`${shared}&page=1&width=480`);
      expect(await centre(await first.body())).toEqual(blueCentre);
      const next = pdf(1, sameSizeRed);
      if (replacement === "renamed over it") {
        await writeFile(`${file}.next`, next);
        await rename(`${file}.next`, file);
      } else await writeFile(file, next);
      await utimes(file, when, when);
      const after = await stat(file);
      expect([after.size, after.mtimeMs]).toEqual([
        before.size,
        before.mtimeMs,
      ]);
      // The new document is another version: no page of it, and no whole file, under the old
      // view's proof. The link's one download is used, so both are refused.
      expect(
        (await visitor.request.get(`${shared}&page=1&width=480`)).status(),
      ).toBe(403);
      expect(
        (
          await visitor.request.get(`/api/share/${token}?path=&preview=1`)
        ).status(),
      ).toBe(404);
    } finally {
      await visitor.close();
    }
  });

test("a view cancelled while it waits for a render slot is not charged", async ({
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
    const queue = await fillRenderQueue(context, folder);
    // Gives up while queued: the browser closes the request before any answer.
    await expect(
      first.request.get(shared, { timeout: 1000 }),
    ).rejects.toThrow();
    await queue.finished;
    const retried = await first.request.get(shared);
    expect(retried.status()).toBe(200);
    // That view, delivered, is the link's one download.
    expect((await second.request.get(shared)).status()).toBe(404);
  } finally {
    await first.close();
    await second.close();
  }
});

test("a view of a PDF changed while it waits is not charged, and reloading shows the new version", async ({
  context,
  browser,
}) => {
  const { folder, rpc } = await pdfFolder(context, 1);
  const file = path.join(await dataRoot(), folder, "page.pdf");
  const { token } = await rpc.shares.create.mutate({
    path: `${folder}/page.pdf`,
    expiresAt: null,
    maxDownloads: 1,
  });
  const visitor = await visitorOf(browser);
  try {
    const shared = `/api/share/${token}/pdf?path=`;
    const queue = await fillRenderQueue(context, folder);
    const waiting = visitor.request.get(shared, { timeout: 120_000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await writeFile(file, pdf(1, red));
    const changed = await waiting;
    await queue.finished;
    expect(changed.status()).toBe(409);
    expect(changed.headers()["set-cookie"]).toBeUndefined();
    // Following the advice to reload works on the one-download link.
    expect((await visitor.request.get(shared)).status()).toBe(200);
    const page = await visitor.request.get(`${shared}&page=1&width=480`);
    expect(await centre(await page.body())).toEqual(redCentre);
    expect(
      (
        await visitor.request.get(`/api/share/${token}?path=&preview=1`)
      ).status(),
    ).toBe(200);
  } finally {
    await visitor.close();
  }
});

test("a view whose pages cannot be drawn is not charged", async ({
  context,
  browser,
}) => {
  const { folder, rpc } = await pdfFolder(context, 1);
  await writeFile(
    path.join(await dataRoot(), folder, "broken.pdf"),
    "not a pdf",
  );
  const { token } = await rpc.shares.create.mutate({
    path: `${folder}/broken.pdf`,
    expiresAt: null,
    maxDownloads: 1,
  });
  const first = await visitorOf(browser);
  const second = await visitorOf(browser);
  try {
    const failed = await first.request.get(`/api/share/${token}/pdf?path=`);
    expect(failed.status()).toBe(422);
    expect(failed.headers()["set-cookie"]).toBeUndefined();
    // The one download is still there for whoever takes the file.
    expect(
      (
        await second.request.get(`/api/share/${token}?path=&download=1`)
      ).status(),
    ).toBe(200);
    expect(
      (
        await first.request.get(`/api/share/${token}?path=&download=1`)
      ).status(),
    ).toBe(404);
  } finally {
    await first.close();
    await second.close();
  }
});

test("requests refused before the claim never count", async ({
  context,
  browser,
}) => {
  const { folder, rpc } = await pdfFolder(context, 1);
  await writeFile(path.join(await dataRoot(), folder, "notes.txt"), "text");
  const { token } = await rpc.shares.create.mutate({
    path: folder,
    expiresAt: null,
    maxDownloads: 1,
  });
  const first = await visitorOf(browser);
  const second = await visitorOf(browser);
  try {
    const base = `/api/share/${token}/pdf?path=`;
    for (const [url, status] of [
      [`${base}page.pdf&page=1&width=500`, 400],
      [`${base}page.pdf&page=1&width=480`, 403],
      [`${base}notes.txt`, 415],
      [`${base}missing.pdf`, 404],
      [`${base}..%2Foutside.pdf`, 403],
    ] as const)
      expect((await first.request.get(url)).status()).toBe(status);
    expect((await first.request.head(`${base}page.pdf`)).status()).toBe(200);
    expect((await second.request.get(`${base}page.pdf`)).status()).toBe(200);
    expect((await first.request.get(`${base}page.pdf`)).status()).toBe(404);
  } finally {
    await first.close();
    await second.close();
  }
});
