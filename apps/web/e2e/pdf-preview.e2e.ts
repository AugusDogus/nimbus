import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Locator } from "@playwright/test";
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

/** A one-page PDF with a filled rectangle. */
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
  const folder = `pdf-${randomUUID()}`;
  const rpc = await client(context);
  await rpc.files.createFolder.mutate({ name: folder });
  await writeFile(path.join(await dataRoot(), folder, "page.pdf"), pdf());
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
