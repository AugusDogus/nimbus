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

test("a throttled unlock says how long to wait instead of calling the password wrong", async ({
  context,
  browser,
}) => {
  const folder = `throttled-${randomUUID()}`;
  const rpc = await client(context);
  await rpc.files.createFolder.mutate({ name: folder });
  const share = await rpc.shares.create.mutate({
    path: folder,
    expiresAt: null,
    password: linkPassword,
  });
  const visitor = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  try {
    const page = await visitor.newPage();
    await page.goto(`/s/${share.token}`);
    await page.route(
      (url) => url.pathname === `/api/share/${share.token}`,
      (route) =>
        route.request().method() === "POST"
          ? route.fulfill({
              status: 429,
              headers: {
                "Retry-After": "20",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ error: "Too many wrong passwords." }),
            })
          : route.continue(),
    );
    await page.getByLabel("Password", { exact: true }).fill(linkPassword);
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText(
      "Too many password attempts on this link. Wait 20 seconds, then try again. Your password was not checked.",
    );
  } finally {
    await visitor.close();
  }
});
