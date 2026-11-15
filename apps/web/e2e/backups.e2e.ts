import { readFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { test } from "./helpers";

test("administrators back up the database on demand and download it; health stays terse", async ({ page, browser }) => {
  await page.goto("/settings/admin");
  const section = page.getByRole("region", { name: "Database backups" });
  await section.getByRole("button", { name: "Back up now", exact: true }).click();
  const backups = section.getByRole("list", { name: "Backups" }).getByRole("listitem");
  await expect(backups.first()).toBeVisible();
  const download = page.waitForEvent("download");
  await backups.first().getByRole("link", { name: "Download", exact: true }).click();
  const saved = await (await download).path();
  if (saved === null) throw new Error("The browser did not save the backup.");
  expect((await readFile(saved)).subarray(0, 15).toString()).toBe("SQLite format 3");

  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    expect((await anonymous.request.get("/api/backups")).status()).toBe(401);
    expect((await anonymous.request.post("/api/backups")).status()).toBe(401);
    const ready = await anonymous.request.get("/api/health");
    expect(ready.status()).toBe(200);
    expect(await ready.json()).toEqual({ status: "ready" });
    const live = await anonymous.request.get("/api/health/live");
    expect(await live.json()).toEqual({ status: "ok" });
  } finally {
    await anonymous.close();
  }
});
