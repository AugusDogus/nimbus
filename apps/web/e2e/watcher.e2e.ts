import { readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "@playwright/test";
import { z } from "zod";
import { client, createFolder, port, test } from "./helpers";
import { FileListing } from "@nimbus/api/file-listing";

test("external disk changes appear live and reserved folder names remain browsable", async ({
  page,
  context,
  isMobile,
}) => {
  const parent = isMobile ? "trash" : "shared";
  const rpc = await client(context);
  const subscription = page.waitForResponse(
    (response) => response.url().includes("files.onChange"),
    { timeout: 15_000 },
  );
  await page.goto("/");
  await subscription;
  await createFolder(page, parent, isMobile);
  await page.getByRole("link", { name: parent, exact: true }).click();
  await expect(page).toHaveURL(`/browse/${parent}`);
  await expect(
    page.getByRole("heading", { name: "This folder is empty" }),
  ).toBeVisible();
  await createFolder(page, "live", isMobile);
  await page.getByRole("link", { name: "live", exact: true }).click();
  await expect(page).toHaveURL(`/browse/${parent}/live`);
  await expect(
    page.getByRole("heading", { name: "This folder is empty" }),
  ).toBeVisible();
  const manifest: unknown = JSON.parse(
    await readFile(path.join(os.tmpdir(), `nimbus-e2e-${port}.json`), "utf8"),
  );
  const { dataRoot } = z
    .object({ dataRoot: z.string().startsWith(os.tmpdir()) })
    .parse(manifest);
  const directory = path.join(dataRoot, parent, "live");
  const source = path.join(directory, "external.txt");
  const destination = path.join(directory, "external-renamed.txt");
  await writeFile(source, "Created outside Nimbus");
  await expect(
    page.locator('[data-entry-name="external.txt"]').filter({ visible: true }),
  ).toBeVisible();
  await rename(source, destination);
  await expect(page.locator('[data-entry-name="external.txt"]')).toHaveCount(0);
  await expect(
    page
      .locator('[data-entry-name="external-renamed.txt"]')
      .filter({ visible: true }),
  ).toBeVisible();
  await rm(destination);
  await expect(
    page.locator('[data-entry-name="external-renamed.txt"]'),
  ).toHaveCount(0);
  expect(
    FileListing.entries(
      await rpc.files.list.query({ path: `${parent}/live` }),
    ).map((entry) => entry.name),
  ).toEqual([]);
});
