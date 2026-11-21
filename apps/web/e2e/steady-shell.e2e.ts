import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { client, test } from "./helpers";

// Scrollbars take space, as on most desktop browsers, rather than overlaying the page.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

/** Every sidebar item's box, by its name. */
const itemBoxes = (page: Page) =>
  page.evaluate(() =>
    Object.fromEntries(
      [
        ...document.querySelectorAll(
          '[data-slot="sidebar-container"] [data-sidebar="menu-button"]',
        ),
      ].map((item) => {
        const box = item.getBoundingClientRect();
        const name =
          item.textContent || item.getAttribute("aria-label") || "unnamed";
        const entry: [string, number[]] = [
          name,
          [box.x, box.y, box.width, box.height],
        ];
        return entry;
      }),
    ),
  );

test("opening a folder leaves the sidebar exactly as it was", async ({
  page,
  context,
  isMobile,
}) => {
  test.skip(isMobile, "The sidebar is a closed sheet on phones.");
  const folder = `steady-${randomUUID()}`;
  await (await client(context)).files.createFolder.mutate({ name: folder });
  await page.goto("/");
  const storage = page.getByRole("region", { name: "Storage usage" });
  await expect(storage.getByText("Nimbus files")).toBeVisible();
  const before = await itemBoxes(page);
  // Records, until the folder shows, whether the storage panel left the page.
  await page.evaluate(() => {
    const changes: string[] = [];
    Object.assign(window, { sidebarChanges: changes });
    const sidebar = document.querySelector('[data-slot="sidebar-container"]');
    if (!sidebar) throw new Error("The desktop sidebar is not on the page.");
    new MutationObserver((records) => {
      for (const record of records) {
        if (
          [...record.removedNodes].some(
            (node) =>
              node instanceof Element &&
              node.matches('[aria-label="Storage usage"]'),
          )
        )
          changes.push("storage removed");
      }
    }).observe(sidebar, { subtree: true, childList: true, attributes: true });
  });
  await page.getByRole("link", { name: folder, exact: true }).click();
  await expect(page).toHaveURL(`/browse/${folder}`);
  await expect(page.getByText("This folder is empty")).toBeVisible();
  expect(
    await page.evaluate(() =>
      "sidebarChanges" in window ? window.sidebarChanges : null,
    ),
  ).toEqual([]);
  expect(await itemBoxes(page)).toEqual(before);
});
