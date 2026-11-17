import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Frame, type Page } from "@playwright/test";
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

/** Chromium's PDF viewer frame inside the page, once it exists. */
const viewer = (page: Page) =>
  page.frames().find((frame) => frame.url().startsWith("chrome-extension://"));

/** The viewer's page count, read through its shadow roots; 0 until the document loads. */
const pageCount = (frame: Frame) =>
  frame.evaluate(() => {
    const find = (root: Document | ShadowRoot): HTMLInputElement | null => {
      for (const element of Array.from(root.querySelectorAll("*"))) {
        if (
          element instanceof HTMLInputElement &&
          element.id === "pageSelector"
        )
          return element;
        if (element.shadowRoot) {
          const found = find(element.shadowRoot);
          if (found) return found;
        }
      }
      return null;
    };
    return Number(find(document)?.value ?? 0);
  });

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
  await expect(
    page.getByRole("dialog", { name: "page.pdf", exact: true }),
  ).toBeVisible();
  await expect.poll(() => viewer(page) !== undefined).toBe(true);
  await expect
    .poll(async () => {
      const frame = viewer(page);
      return frame ? await pageCount(frame) : 0;
    })
    .toBe(1);
});
