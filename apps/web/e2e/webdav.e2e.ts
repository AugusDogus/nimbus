import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "@playwright/test";
import { z } from "zod";
import { test } from "./helpers";
import { adminEmail, client, origin, port } from "./helpers";

async function dataRoot() {
  const manifest: unknown = JSON.parse(
    await readFile(path.join(os.tmpdir(), `nimbus-e2e-${port}.json`), "utf8"),
  );
  return z
    .object({ dataRoot: z.string().startsWith(os.tmpdir()) })
    .parse(manifest).dataRoot;
}

test("WebDAV app passwords support file operations and stop working after revocation", async ({
  page,
  context,
  request,
}, testInfo) => {
  const folder = `dav-${randomUUID()}`;
  const device = `Laptop ${randomUUID()}`;
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/settings/webdav");
  await expect(
    page.getByRole("textbox", { name: "Server address", exact: true }),
  ).toHaveValue(`${origin}/dav/`);
  await expect(
    page.getByRole("textbox", { name: "Username", exact: true }),
  ).toHaveValue(adminEmail);
  await page
    .getByRole("button", { name: "Copy server address", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Server address copied" }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `${origin}/dav/`,
  );
  await page
    .getByRole("button", { name: "Create password", exact: true })
    .click();
  await page.getByLabel("Device name").fill(device);
  await page
    .getByRole("dialog", { name: "Create app password", exact: true })
    .getByRole("button", { name: "Create password", exact: true })
    .click();
  const token = page.getByRole("textbox", {
    name: "App password",
    exact: true,
  });
  await expect(token).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(token).toBeVisible();
  const headers = {
    Authorization: `Basic ${Buffer.from(`${adminEmail}:${await token.inputValue()}`).toString("base64")}`,
  };
  await page.getByRole("button", { name: "I’ve saved it" }).click();
  expect((await request.get("/dav/alpha.txt")).status()).toBe(401);
  expect(
    (
      await request.fetch(`/dav/${folder}`, { method: "MKCOL", headers })
    ).status(),
  ).toBe(201);
  const original = `/dav/${folder}/note.txt`;
  expect(
    (
      await request.put(original, { headers, data: "Created through WebDAV" })
    ).status(),
  ).toBe(201);
  const get = await request.get(original, { headers });
  expect(get.status()).toBe(200);
  expect(await get.text()).toBe("Created through WebDAV");
  expect(
    (
      await request.put(original, {
        headers: { ...headers, "If-Match": '"stale-version"' },
        data: "Stale edit",
      })
    ).status(),
  ).toBe(412);
  const range = await request.get(original, {
    headers: { ...headers, Range: "bytes=0-6" },
  });
  expect(range.status()).toBe(206);
  expect(await range.text()).toBe("Created");
  const propfind = await request.fetch(`/dav/${folder}/`, {
    method: "PROPFIND",
    headers: { ...headers, Depth: "1" },
  });
  expect(propfind.status()).toBe(207);
  expect(await propfind.text()).toContain("note.txt");
  const renamed = `/dav/${folder}/renamed.txt`;
  expect(
    (
      await request.fetch(original, {
        method: "MOVE",
        headers: { ...headers, Destination: `${origin}${renamed}` },
      })
    ).status(),
  ).toBe(201);
  expect((await request.get(original, { headers })).status()).toBe(404);
  expect((await request.get(renamed, { headers })).status()).toBe(200);
  // Without a body, LOCK refreshes an existing lock named in the If header (RFC 4918, section 9.10.2).
  expect(
    (await request.fetch(renamed, { method: "LOCK", headers })).status(),
  ).toBe(412);
  const lock = await request.fetch(renamed, {
    method: "LOCK",
    headers: {
      ...headers,
      "Content-Type": "application/xml",
      Timeout: "Second-600",
    },
    data: '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner>e2e</D:owner></D:lockinfo>',
  });
  expect(lock.status()).toBe(200);
  expect(await lock.text()).toContain("Second-600");
  expect(
    (
      await request.put(renamed, {
        headers,
        data: "Must not overwrite a locked file",
      })
    ).status(),
  ).toBe(423);
  const lockToken = lock.headers()["lock-token"];
  if (!lockToken) throw new Error("WebDAV LOCK did not return a lock token.");
  const rpc = await client(context);
  await expect(
    rpc.files.rename.mutate({
      path: `${folder}/renamed.txt`,
      newName: "locked-rename.txt",
    }),
  ).rejects.toMatchObject({ data: { code: "CONFLICT" } });
  await expect(
    rpc.files.delete.mutate({ path: `${folder}/renamed.txt` }),
  ).rejects.toMatchObject({ data: { code: "CONFLICT" } });
  expect(
    (
      await request.put(renamed, {
        headers: { ...headers, If: `(${lockToken})` },
        data: "Saved with the lock token",
      })
    ).status(),
  ).toBe(204);
  expect(
    (
      await request.fetch(renamed, {
        method: "LOCK",
        headers: { ...headers, If: `(${lockToken})`, Timeout: "Second-120" },
      })
    ).status(),
  ).toBe(200);
  expect(
    (
      await request.fetch(renamed, {
        method: "UNLOCK",
        headers: { ...headers, "Lock-Token": lockToken },
      })
    ).status(),
  ).toBe(204);
  expect((await request.delete(renamed, { headers })).status()).toBe(204);
  expect((await request.get(renamed, { headers })).status()).toBe(404);
  const deviceRow = page
    .getByRole("list", { name: "App passwords", exact: true })
    .getByRole("listitem")
    .filter({ hasText: device });
  await deviceRow.getByRole("button", { name: "Revoke", exact: true }).click();
  expect(
    await page
      .getByRole("alertdialog")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page
    .getByRole("alertdialog", { name: "Revoke app password?" })
    .getByRole("button", { name: "Revoke", exact: true })
    .click();
  await expect(
    page.getByRole("alertdialog", { name: "Revoke app password?" }),
  ).toBeHidden();
  await expect(deviceRow).toHaveCount(0);
  expect((await request.get("/dav/alpha.txt", { headers })).status()).toBe(401);
  await page.evaluate(async () => {
    window.scrollTo(0, 0);
    document
      .querySelectorAll('[role="dialog"]')
      .forEach((dialog) => dialog.scrollTo(0, 0));
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  await page.screenshot({
    path: testInfo.outputPath("settings.png"),
    fullPage: true,
  });
});

test("WebDAV MKCOL and LOCK never revive the public links of content removed outside Nimbus", async ({
  context,
  request,
}) => {
  const rpc = await client(context);
  const { token } = await rpc.appPasswords.create.mutate({
    name: `Vacant ${randomUUID()}`,
  });
  const headers = {
    Authorization: `Basic ${Buffer.from(`${adminEmail}:${token}`).toString("base64")}`,
  };
  const folder = `vacant-${randomUUID()}`;
  await rpc.files.createFolder.mutate({ name: folder });
  await rpc.files.createFolder.mutate({ path: folder, name: "old" });
  const linked = await rpc.shares.create.mutate({
    path: `${folder}/old`,
    expiresAt: null,
  });
  const lockedName = `${folder}/locked.txt`;
  expect(
    (
      await request.put(`/dav/${lockedName}`, { headers, data: "shared" })
    ).status(),
  ).toBe(201);
  const lockedLink = await rpc.shares.create.mutate({
    path: lockedName,
    expiresAt: null,
  });
  // Another program, such as an SMB client, deletes both.
  const root = await dataRoot();
  await rm(path.join(root, folder, "old"), { recursive: true });
  await rm(path.join(root, lockedName));

  expect(
    (
      await request.fetch(`/dav/${folder}/old`, { method: "MKCOL", headers })
    ).status(),
  ).toBe(201);
  const locked = await request.fetch(`/dav/${lockedName}`, {
    method: "LOCK",
    headers: { ...headers, "Content-Type": "application/xml" },
    data: '<?xml version="1.0"?><d:lockinfo xmlns:d="DAV:"><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockinfo>',
  });
  // Released at once: locks count against the account's limit for later tests.
  expect(
    (
      await request.fetch(`/dav/${lockedName}`, {
        method: "UNLOCK",
        headers: {
          ...headers,
          "Lock-Token": locked.headers()["lock-token"] ?? "",
        },
      })
    ).status(),
  ).toBe(204);
  expect(locked.status()).toBe(201);
  const live = (await rpc.shares.list.query()).map((share) => share.token);
  expect(live).not.toContain(linked.token);
  expect(live).not.toContain(lockedLink.token);
});
