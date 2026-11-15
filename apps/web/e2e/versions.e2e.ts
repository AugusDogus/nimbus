import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { action, adminEmail, client, downloadText, origin, test } from "./helpers";

test("replacing a file over WebDAV keeps versions that follow moves and can be restored", async ({ page, context, request, isMobile }) => {
  const rpc = await client(context);
  const folder = `versions-${randomUUID()}`;
  const { token } = await rpc.appPasswords.create.mutate({ name: `Versions ${randomUUID()}` });
  const headers = { Authorization: `Basic ${Buffer.from(`${adminEmail}:${token}`).toString("base64")}` };
  expect((await request.fetch(`/dav/${folder}`, { method: "MKCOL", headers })).status()).toBe(201);
  const original = `/dav/${folder}/plan.txt`;
  expect((await request.put(original, { headers, data: "first draft" })).status()).toBe(201);
  expect((await request.put(original, { headers, data: "second draft" })).status()).toBe(204);
  expect((await request.put(original, { headers, data: "final draft" })).status()).toBe(204);
  // History belongs to the file, so it survives a rename.
  expect((await request.fetch(original, { method: "MOVE", headers: { ...headers, Destination: `${origin}/dav/${folder}/renamed.txt` } })).status()).toBe(201);
  const versions = await rpc.versions.list.query({ path: `${folder}/renamed.txt` });
  expect(versions.map((version) => version.size)).toEqual(["second draft".length, "first draft".length]);

  await page.goto(`/browse/${folder}`);
  await action(page, "renamed.txt", "Version history", isMobile);
  const dialog = page.getByRole("dialog", { name: "Versions of renamed.txt" });
  const rows = dialog.getByRole("listitem");
  await expect(rows).toHaveCount(2);
  const download = page.waitForEvent("download");
  await rows.last().getByRole("link", { name: "Download", exact: true }).click();
  expect(await downloadText(await download)).toBe("first draft");
  await rows.last().getByRole("button", { name: "Restore", exact: true }).click();
  await rows.last().getByRole("button", { name: "Confirm restore", exact: true }).click();
  await expect(rows).toHaveCount(3);
  const restored = await request.get(`/dav/${folder}/renamed.txt`, { headers });
  expect(await restored.text()).toBe("first draft");
  // Each version records who replaced it.
  await expect(dialog.getByText("Replaced by", { exact: false }).first()).toBeVisible();
});
