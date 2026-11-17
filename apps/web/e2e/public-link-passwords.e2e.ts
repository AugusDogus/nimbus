import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { client, test } from "./helpers";

const linkPassword = "link-password-42";

/** Opens `path` with the page's code held back, types the password, then lets the code run. */
async function typeBeforeHydration(page: Page, path: string) {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\.(js|tsx?)(\?|$)/, async (route) => {
    await released;
    await route.continue();
  });
  await page.goto(path, { waitUntil: "commit" });
  const field = page.getByLabel("Password", { exact: true });
  await field.pressSequentially(linkPassword);
  const unlock = page.getByRole("button", { name: "Unlock", exact: true });
  // Until the code runs a click would submit the form natively and reload the page.
  await expect(unlock).toBeDisabled();
  release();
  await expect(unlock).toBeEnabled();
  await expect(field).toHaveValue(linkPassword);
  await unlock.click();
}

test("public link passwords typed before the page's code loads still unlock", async ({
  context,
  browser,
}) => {
  const folder = `early-password-${randomUUID()}`;
  const rpc = await client(context);
  await rpc.files.createFolder.mutate({ name: folder });
  const share = await rpc.shares.create.mutate({
    path: folder,
    expiresAt: null,
    password: linkPassword,
  });
  const request = await rpc.fileRequests.create.mutate({
    path: folder,
    note: "",
    expiresAt: null,
    maxFileBytes: null,
    maxFiles: null,
    maxTotalBytes: null,
    password: linkPassword,
  });
  const visitor = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  try {
    const sharePage = await visitor.newPage();
    await typeBeforeHydration(sharePage, `/s/${share.token}`);
    await expect(
      sharePage.getByRole("heading", { name: folder, exact: true }),
    ).toBeVisible();

    const requestPage = await visitor.newPage();
    await typeBeforeHydration(requestPage, `/r/${request.token}`);
    await expect(
      requestPage.getByRole("heading", { name: `Upload files to ${folder}` }),
    ).toBeVisible();
  } finally {
    await visitor.close();
  }
});
