import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { client, test } from "./helpers";
import { dataRoot, pdf } from "./pdf-files";

// Full Chromium, which has the PDF viewer whose own download button is checked here.
test.use({ channel: "chromium" });

/** A name with what RFC 8187 must escape: an apostrophe, parentheses, non-ASCII, a quote mark. */
const name = "Zoë's Café “Notes” (v2).pdf";

/** The name the PDF viewer in `page` saves the document under, from its own download button. */
async function viewerDownloadName(page: Page) {
  await expect
    .poll(
      () =>
        page
          .frames()
          .some((frame) => frame.url().startsWith("chrome-extension://")),
      { timeout: 60_000 },
    )
    .toBe(true);
  const viewer = page
    .frames()
    .find((frame) => frame.url().startsWith("chrome-extension://"));
  if (!viewer) throw new Error("The PDF viewer did not load.");
  const save = viewer.locator("cr-icon-button#save");
  await expect(save).toHaveCount(1, { timeout: 60_000 });
  const download = page.waitForEvent("download");
  // The toolbar shows on hover; the button works the same without it.
  await save.dispatchEvent("click");
  return (await download).suggestedFilename();
}

test("a shared file downloads, and saves from the PDF viewer, under its own name", async ({
  context,
  browser,
  isMobile,
}) => {
  test.skip(isMobile, "Downloads and the viewer are the same on mobile.");
  const folder = `names-${randomUUID()}`;
  const rpc = await client(context);
  await rpc.files.createFolder.mutate({ name: folder });
  await writeFile(path.join(await dataRoot(), folder, name), pdf(1));
  const { token } = await rpc.shares.create.mutate({
    path: `${folder}/${name}`,
    expiresAt: null,
  });
  const visitor = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  try {
    const page = await visitor.newPage();
    await page.goto(`/s/${token}`);
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download", exact: true }).click();
    expect((await download).suggestedFilename()).toBe(name);
    // The viewer in the page's frame, and in a tab of its own.
    expect(await viewerDownloadName(page)).toBe(name);
    const tab = await visitor.newPage();
    await tab.goto(`/api/share/${token}?path=&preview=1`).catch(() => null);
    expect(await viewerDownloadName(tab)).toBe(name);
  } finally {
    await visitor.close();
  }
});

test("a shared folder's ZIP downloads under the folder's name", async ({
  context,
  browser,
  isMobile,
}) => {
  test.skip(isMobile, "Downloads are the same on mobile.");
  const folder = `Föld'er (${randomUUID().slice(0, 8)})`;
  const rpc = await client(context);
  await rpc.files.createFolder.mutate({ name: folder });
  await mkdir(path.join(await dataRoot(), folder, "inner"));
  await writeFile(path.join(await dataRoot(), folder, "inner", name), pdf(1));
  const { token } = await rpc.shares.create.mutate({
    path: folder,
    expiresAt: null,
  });
  const visitor = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  try {
    const page = await visitor.newPage();
    await page.goto(`/s/${token}`);
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download ZIP" }).click();
    expect((await download).suggestedFilename()).toBe(`${folder}.zip`);
  } finally {
    await visitor.close();
  }
});

test("a public link's page is titled with the shared item's name, so printing or saving the page keeps it", async ({
  context,
  browser,
}) => {
  const folder = `titles-${randomUUID()}`;
  const rpc = await client(context);
  await rpc.files.createFolder.mutate({ name: folder });
  await writeFile(path.join(await dataRoot(), folder, name), pdf(1));
  await writeFile(path.join(await dataRoot(), folder, "other.pdf"), pdf(1));
  const file = await rpc.shares.create.mutate({
    path: `${folder}/${name}`,
    expiresAt: null,
  });
  const all = await rpc.shares.create.mutate({ path: folder, expiresAt: null });
  const locked = await rpc.shares.create.mutate({
    path: `${folder}/${name}`,
    expiresAt: null,
    password: "title-locked-pass-42",
  });
  const visitor = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  try {
    // In the page the server sends, before any script runs: browsers name a printout or a
    // saved page after it, adding their own extension, so the title has none.
    const html = await (await visitor.request.get(`/s/${file.token}`)).text();
    expect(html).toContain("<title>Zoë&#39;s Café “Notes” (v2)</title>");
    const page = await visitor.newPage();
    await page.goto(`/s/${file.token}`);
    await expect(page).toHaveTitle("Zoë's Café “Notes” (v2)");
    // A folder link follows what the visitor opens in it.
    await page.goto(`/s/${all.token}`);
    await expect(page).toHaveTitle(folder);
    await page.getByRole("button", { name: "other.pdf" }).click();
    await expect(page).toHaveTitle("other");
    // A locked link names nothing before it is unlocked. Checked on text no hashed asset name
    // can contain, in every form the page could carry it: plain, escaped and percent-encoded.
    await page.goto(`/s/${locked.token}`);
    await expect(page).toHaveTitle("Nimbus");
    const lockedHtml = await (
      await visitor.request.get(`/s/${locked.token}`)
    ).text();
    for (const form of [
      "Zoë",
      "Café “Notes”",
      "Zo&#235;",
      "Caf&#233;",
      "Zo&#xEB;",
      "Caf&#xE9;",
      "Zo%C3%AB",
      "Caf%C3%A9",
    ])
      expect(lockedHtml).not.toContain(form);
  } finally {
    await visitor.close();
  }
});
