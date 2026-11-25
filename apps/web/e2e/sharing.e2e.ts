import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { test } from "./helpers";
import {
  action,
  client,
  createFolder,
  downloadText,
  login,
  origin,
  password,
  upload,
} from "./helpers";

test("public folder links require passwords, confine downloads and honor revocation and expiry", async ({
  page,
  context,
  browser,
  isMobile,
}, testInfo) => {
  const folder = `shared-${randomUUID()}`;
  const body = "A file shared with someone outside Nimbus.";
  const rpc = await client(context);
  await page.goto("/");
  await createFolder(page, folder, isMobile);
  await page.getByRole("link", { name: folder, exact: true }).click();
  await expect(page).toHaveURL(`/browse/${folder}`);
  await expect(
    page.getByRole("heading", { name: "This folder is empty" }),
  ).toBeVisible();
  await upload(page, "shared-note.txt", body);
  await page.goto("/");
  await action(page, folder, "Share", isMobile);
  const sharing = page.getByRole("dialog", {
    name: `Share ${folder}`,
    exact: true,
  });
  await sharing.getByLabel("Password (optional)").fill("share-password-42");
  await sharing
    .getByRole("button", { name: "Create link", exact: true })
    .click();
  const link = sharing.getByRole("textbox", {
    name: "Share link",
    exact: true,
  });
  await expect(link).toBeVisible();
  await link.scrollIntoViewIfNeeded();
  await expect(
    sharing.getByRole("heading", { name: `Share ${folder}`, exact: true }),
  ).toBeInViewport();
  await expect(
    sharing.getByRole("button", { name: "Close", exact: true }),
  ).toBeInViewport();
  const publicURL = await link.inputValue();
  const publicPath = new URL(publicURL).pathname;
  const token = publicPath.split("/").pop();
  if (!token) throw new Error("The share UI did not provide a token.");
  await page.evaluate(async () => {
    window.scrollTo(0, 0);
    document
      .querySelectorAll('[role="dialog"]')
      .forEach((dialog) => dialog.scrollTo(0, 0));
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  await page.screenshot({
    path: testInfo.outputPath("sharing.png"),
    fullPage: true,
  });
  const anonymous = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: page.viewportSize(),
  });
  try {
    const visitor = await anonymous.newPage();
    expect(
      (await anonymous.request.get(`/api/share/${token}?download=1`)).status(),
    ).toBe(401);
    await visitor.goto(publicURL);
    await expect(
      visitor.getByRole("heading", { name: "Protected share" }),
    ).toBeVisible();
    await visitor
      .getByLabel("Password", { exact: true })
      .fill("incorrect-password");
    await visitor.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(
      visitor.getByRole("alert").filter({ hasText: "incorrect" }),
    ).toBeVisible();
    await visitor
      .getByLabel("Password", { exact: true })
      .fill("share-password-42");
    await visitor.getByRole("button", { name: "Unlock", exact: true }).click();
    await visitor
      .getByRole("button", { name: "shared-note.txt", exact: true })
      .click();
    await expect(visitor.locator("pre")).toHaveText(body);
    const download = visitor.waitForEvent("download");
    await visitor.getByRole("link", { name: "Download", exact: true }).click();
    expect(await downloadText(await download)).toBe(body);
    const escaped = await anonymous.request.get(
      `/api/share/${token}?path=${encodeURIComponent("../alpha.txt")}&download=1`,
    );
    expect(escaped.status()).toBe(403);
    await visitor.getByRole("button", { name: "Parent folder" }).click();
    const zip = await anonymous.request.get(`/api/share/${token}?download=1`);
    expect(zip.status()).toBe(200);
    expect((await zip.body()).subarray(0, 2).toString()).toBe("PK");
    await visitor.screenshot({
      path: testInfo.outputPath("public-share.png"),
      fullPage: true,
    });
    await page.goto("/shared");
    await expect(
      page.getByRole("heading", { name: "Shared", exact: true }),
    ).toBeVisible();
    const received = page.getByRole("tab", {
      name: "Shared with me",
      exact: true,
    });
    const publicLinks = page.getByRole("tab", {
      name: "Public links",
      exact: true,
    });
    await expect(received).toHaveAttribute("aria-selected", "true");
    await received.focus();
    await received.press("ArrowRight");
    await expect(publicLinks).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL("/shared?tab=links");
    await page.reload();
    await expect(publicLinks).toHaveAttribute("aria-selected", "true");
    await received.click();
    await expect(page).toHaveURL("/shared");
    await page.goto("/shares");
    await expect(page).toHaveURL("/shared?tab=links");
    await expect(publicLinks).toHaveAttribute("aria-selected", "true");
    const record = page.getByRole("listitem").filter({
      has: page.getByRole("link", { name: `Files / ${folder}`, exact: true }),
    });
    await record.getByRole("button", { name: "Revoke", exact: true }).click();
    const confirm = page.getByRole("alertdialog", {
      name: "Revoke this link?",
    });
    await confirm.getByRole("button", { name: "Revoke link" }).click();
    // The open dialog hides the list from the accessibility tree, so wait for it to close,
    // which happens once the server has revoked the link.
    await expect(confirm).toBeHidden();
    await expect(record).toHaveCount(0);
    await visitor.reload();
    await expect(
      visitor.getByRole("heading", { name: "Share unavailable" }),
    ).toBeVisible();
    expect(
      (await anonymous.request.get(`/api/share/${token}?download=1`)).status(),
    ).toBe(404);
    const expiring = await rpc.shares.create.mutate({
      path: folder,
      expiresAt: Date.now() + 2000,
    });
    expect(
      (await anonymous.request.get(`/api/share/${expiring.token}`)).status(),
    ).toBe(200);
    await expect
      .poll(
        async () =>
          (
            await anonymous.request.get(`/api/share/${expiring.token}`)
          ).status(),
        { timeout: 5000 },
      )
      .toBe(404);
  } finally {
    await anonymous.close();
  }
});

test("someone who may share a folder, but is not an administrator, shares it with a group", async ({
  page,
  browser,
  context,
  isMobile,
}) => {
  const suffix = randomUUID().slice(0, 8);
  const email = `sharer-${suffix}@nimbus.test`;
  const created = await context.request.post("/api/auth/admin/create-user", {
    headers: { Origin: origin },
    data: { name: "Lee Sharer", email, password, role: "user" },
  });
  expect(created.ok()).toBe(true);
  const body: unknown = await created.json();
  const id =
    typeof body === "object" &&
    body !== null &&
    "user" in body &&
    typeof body.user === "object" &&
    body.user !== null &&
    "id" in body.user &&
    typeof body.user.id === "string"
      ? body.user.id
      : null;
  if (!id) throw new Error("Creating the member returned no user id.");
  const rpc = await client(context);
  const folder = `group-share-${suffix}`;
  const group = `Reviewers ${suffix}`;
  await rpc.files.createFolder.mutate({ name: folder });
  await rpc.access.saveGroup.mutate({ name: group, memberIds: [] });
  await rpc.access.grant.mutate({
    path: folder,
    subject: { type: "user", id },
    permission: "admin",
  });
  const member = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: page.viewportSize(),
  });
  try {
    const sharer = await member.newPage();
    await login(sharer, email);
    await sharer.goto("/shared");
    await action(sharer, folder, "Share", isMobile);
    const dialog = sharer.getByRole("dialog", { name: new RegExp(folder) });
    await dialog.getByRole("combobox", { name: "Person or group" }).click();
    await sharer.getByRole("option", { name: `Group: ${group}` }).click();
    await dialog
      .getByRole("button", { name: "Grant access", exact: true })
      .click();
    // The grant is listed by the group's name, which is all a non-administrator is told.
    await expect(dialog.getByText(`${group} · read`)).toBeVisible();
  } finally {
    await member.close();
  }
});

test("a dead link says why it stopped, without naming what it shared", async ({
  context,
  browser,
}) => {
  const folder = `dead-link-secret-${randomUUID().slice(0, 8)}`;
  const rpc = await client(context);
  await rpc.files.createFolder.mutate({ name: folder });
  const anonymous = await browser.newContext({ storageState: undefined });
  const visitor = await anonymous.newPage();
  // The page and the endpoint say the same thing, and neither names the folder.
  const expectDead = async (token: string, message: string) => {
    const response = await anonymous.request.get(`/api/share/${token}`);
    expect(response.status()).toBe(404);
    expect(await response.json()).toEqual({ error: message });
    await visitor.goto(`/s/${token}`);
    await expect(
      visitor.getByRole("heading", { name: "Share unavailable" }),
    ).toBeVisible();
    await expect(visitor.getByRole("alert")).toHaveText(message);
    await expect(visitor).toHaveTitle("Nimbus");
    expect(await visitor.locator("body").innerText()).not.toContain(folder);
  };
  try {
    const revoked = await rpc.shares.create.mutate({
      path: folder,
      expiresAt: null,
    });
    const id = (await rpc.shares.list.query()).find(
      (share) => share.token === revoked.token,
    )?.id;
    expect(id).toBeDefined();
    await rpc.shares.revoke.mutate({ id: id ?? "" });
    await expectDead(
      revoked.token,
      "The person who shared this link turned it off, so it no longer opens. Ask them for a new link if you still need it.",
    );

    // A token never issued reads like any other unknown one, revealing nothing.
    await expectDead(
      revoked.token.replace(/^./, (first) => (first === "a" ? "b" : "a")),
      "This link does not open. Check that you have the whole address, or ask the person who shared it for a new link.",
    );

    const limited = await rpc.shares.create.mutate({
      path: folder,
      expiresAt: null,
      maxDownloads: 1,
    });
    expect(
      (
        await anonymous.request.get(`/api/share/${limited.token}?download=1`)
      ).status(),
    ).toBe(200);
    await expectDead(
      limited.token,
      "This link has reached its download limit, so it no longer opens. Ask the person who shared it for a new link.",
    );

    // A password does not hide that the link has expired, as before.
    const expiring = await rpc.shares.create.mutate({
      path: folder,
      expiresAt: Date.now() + 1500,
      password: "dead-link-password",
    });
    await expect
      .poll(
        async () =>
          (
            await anonymous.request.get(`/api/share/${expiring.token}`)
          ).status(),
        { timeout: 10_000 },
      )
      .toBe(404);
    await expectDead(
      expiring.token,
      "This link has expired, so it no longer opens. Ask the person who shared it for a new link.",
    );
  } finally {
    await anonymous.close();
  }
});
