import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAccess } from "@nimbus/api/access";
import type { Share } from "@nimbus/api/drive-store";
import { createTestDriveStore } from "@nimbus/api/testing";
import { hookFileHandle } from "./file-handle-testing";
import { PdfPagesRoute } from "./pdf-pages-route";

const poppler =
  Bun.which("pdfinfo") !== null &&
  Bun.which("pdftoppm") !== null &&
  Bun.which("prlimit") !== null;

/** A one-page 400×200pt PDF. */
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

describe.skipIf(!poppler)("a public link's counted PDF view", () => {
  let root: string;
  const previousRoot = process.env.NIMBUS_DATA_ROOT;
  beforeEach(async () => {
    process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret";
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-pdf-route-"));
    process.env.NIMBUS_DATA_ROOT = root;
    await writeFile(path.join(root, "page.pdf"), pdf());
  });
  afterEach(async () => {
    if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
    else process.env.NIMBUS_DATA_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  });

  /** A one-download link to page.pdf, and its view's request with `signal`. */
  async function counted(signal?: AbortSignal) {
    const { store } = createTestDriveStore();
    const created: Share = {
      id: "link",
      token: "token",
      path: "page.pdf",
      createdBy: "user-1",
      createdAt: 0,
      expiresAt: null,
      passwordHash: null,
      downloadCount: 0,
      maxDownloads: 1,
      mode: "download",
    };
    await store.createShare(created);
    const access = await getAccess(store, "user-1");
    const view = () =>
      PdfPagesRoute.serve(
        new Request("http://localhost/api/share/token/pdf?path=", { signal }),
        async () => ({ access, relative: "page.pdf", share: created }),
        store,
      );
    const count = async () =>
      (await store.getShare("token"))?.downloadCount ?? -1;
    return { view, count };
  }

  test("is charged when it answers with the pages", async () => {
    const { view, count } = await counted();
    const answer = await view();
    expect(answer.status).toBe(200);
    expect(answer.headers.get("set-cookie")).toStartWith("nimbus-transfer-");
    expect(await count()).toBe(1);
  });

  test("is not charged when its request leaves while the file is being released", async () => {
    const controller = new AbortController();
    const { view, count } = await counted(controller.signal);
    // After the pages are drawn and checked, the request goes away during the descriptor's close.
    const restore = await hookFileHandle("close", "before", 1, () =>
      controller.abort(),
    );
    try {
      const answer = await view();
      expect(answer.status).toBe(499);
      expect(answer.headers.get("set-cookie")).toBeNull();
      expect(await count()).toBe(0);
    } finally {
      restore();
    }
  });

  test("is not charged when its pages cannot be drawn", async () => {
    await writeFile(path.join(root, "page.pdf"), "not a pdf");
    const { view, count } = await counted();
    const answer = await view();
    expect(answer.status).toBe(422);
    expect(answer.headers.get("set-cookie")).toBeNull();
    expect(await count()).toBe(0);
  });

  test("is not charged when its request leaves while the pages are drawn", async () => {
    const controller = new AbortController();
    const { view, count } = await counted(controller.signal);
    // The renderer's last step states the file; the request goes away just after.
    const restore = await hookFileHandle("stat", "after", 2, () =>
      controller.abort(),
    );
    try {
      expect((await view()).status).toBe(499);
      expect(await count()).toBe(0);
    } finally {
      restore();
    }
  });

  test("is refused without drawing when no download is left", async () => {
    const { view, count } = await counted();
    expect((await view()).status).toBe(200);
    // A render would state the file a second time, after Poppler; that must not happen.
    const restore = await hookFileHandle("stat", "after", 2, () => {
      throw new Error("A refused view reached the renderer.");
    });
    try {
      expect((await view()).status).toBe(404);
    } finally {
      restore();
    }
    expect(await count()).toBe(1);
  });

  test("HEAD is answered without counting, drawing or a proof", async () => {
    const { store } = createTestDriveStore();
    const share: Share = {
      id: "head",
      token: "head",
      path: "page.pdf",
      createdBy: "user-1",
      createdAt: 0,
      expiresAt: null,
      passwordHash: null,
      downloadCount: 0,
      maxDownloads: 1,
      mode: "download",
    };
    await store.createShare(share);
    const access = await getAccess(store, "user-1");
    const answer = await PdfPagesRoute.serve(
      new Request("http://localhost/api/share/head/pdf?path=", {
        method: "HEAD",
      }),
      async () => ({ access, relative: "page.pdf", share }),
      store,
    );
    expect(answer.status).toBe(200);
    expect(answer.headers.get("set-cookie")).toBeNull();
    expect((await store.getShare("head"))?.downloadCount).toBe(0);
  });
});
