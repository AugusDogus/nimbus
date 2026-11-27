import { expect, type Browser, type Page } from "@playwright/test";
import { VsCodeTheme } from "../lib/vscode-theme";
import { asMember, login, test } from "./helpers";

// lib/theme-preferences.ts imports JSON, which Playwright's loader cannot; its keys are copied.
const themeStorageKey = "nimbus-themes-v1";
const themeOwnerStorageKey = "nimbus-themes-owner";

// Color themes belong to the account: imported in one browser, they show in another, and a
// browser that saved themes before they synced brings them to the account once. Each test uses
// a member account of its own, so the shared administrator's themes stay untouched.

const night = {
  name: "Sync Night",
  colors: { "editor.background": "#112233", "sideBar.background": "#102030" },
};

/** A second browser signed in to `email`, in dark mode. */
async function secondBrowser(browser: Browser, email: string) {
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    colorScheme: "dark",
  });
  const page = await context.newPage();
  await login(page, email);
  return { context, page };
}

/** The body's background in the first frame the page could paint, before any app code ran. */
async function firstPaintBackground(page: Page) {
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      Object.assign(window, {
        firstPaint: getComputedStyle(document.body).backgroundColor,
      });
    });
  });
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  return page.evaluate(() => String(Reflect.get(window, "firstPaint")));
}

test("color themes follow the account to another browser and paint there without a flash", async ({
  browser,
  context,
  page,
  isMobile,
}) => {
  const { member, memberContext, email } = await asMember(
    browser,
    context,
    page,
    isMobile,
    [],
  );
  const other = await secondBrowser(browser, email);
  try {
    await member.emulateMedia({ colorScheme: "dark" });
    await member.goto("/settings/appearance");
    await member
      .getByRole("button", { name: "Add theme", exact: true })
      .click();
    await member
      .locator('input[aria-label="Import VS Code theme files"]')
      .setInputFiles({
        name: "night.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(night)),
      });
    const chosen = member.getByRole("button", {
      name: "Use Sync Night for dark mode",
      exact: true,
    });
    await expect(chosen).toHaveAttribute("aria-pressed", "true");
    await expect(member.locator("body")).toHaveCSS(
      "background-color",
      "rgb(17, 34, 51)",
    );

    // The other browser never saw the import; it takes the account's copy when it loads.
    await other.page.goto("/settings/appearance");
    await expect(
      other.page.getByRole("button", {
        name: "Use Sync Night for dark mode",
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(other.page.locator("body")).toHaveCSS(
      "background-color",
      "rgb(17, 34, 51)",
    );
    // From then on its own copy paints the theme before the app loads.
    expect(await firstPaintBackground(other.page)).toBe("rgb(17, 34, 51)");

    // Choosing the default palette elsewhere reaches the first browser on its next load.
    await other.page
      .getByRole("button", { name: "Use Nimbus for dark mode", exact: true })
      .click();
    await expect(other.page.locator("body")).toHaveCSS(
      "background-color",
      "rgb(34, 36, 41)",
    );
    await member.reload();
    await expect(chosen).toHaveAttribute("aria-pressed", "false");
    await expect(member.locator("body")).toHaveCSS(
      "background-color",
      "rgb(34, 36, 41)",
    );
  } finally {
    await other.context.close();
    await memberContext.close();
  }
});

test("a browser's themes saved before syncing move to the account once", async ({
  browser,
  context,
  page,
  isMobile,
}) => {
  const { memberContext, email } = await asMember(
    browser,
    context,
    page,
    isMobile,
    [],
  );
  await memberContext.close();
  const parsed = VsCodeTheme.parse(
    JSON.stringify({
      name: "Legacy Dusk",
      colors: { "editor.background": "#332211" },
    }),
    "dusk.json",
  );
  if (!parsed.ok) throw new Error(parsed.error);
  const legacy = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    colorScheme: "dark",
  });
  const fresh = await secondBrowser(browser, email);
  try {
    // A browser from before the update: themes saved locally, no owner mark.
    const before = await legacy.newPage();
    await before.goto("/login");
    await before.evaluate(
      ({ key, value }) => localStorage.setItem(key, value),
      {
        key: themeStorageKey,
        value: JSON.stringify({
          version: 1,
          themes: [parsed.value],
          light: null,
          dark: parsed.value.id,
        }),
      },
    );
    await login(before, email);
    await expect
      .poll(() =>
        before.evaluate(
          (key) => localStorage.getItem(key),
          themeOwnerStorageKey,
        ),
      )
      .not.toBeNull();
    await expect(before.locator("body")).toHaveCSS(
      "background-color",
      "rgb(51, 34, 17)",
    );

    await fresh.page.goto("/settings/appearance");
    await expect(
      fresh.page.getByRole("button", {
        name: "Use Legacy Dusk for dark mode",
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", "true");

    // Once marked, the browser takes the account's copy: removing the theme elsewhere sticks.
    await fresh.page
      .getByRole("button", { name: "Remove Legacy Dusk", exact: true })
      .click();
    await fresh.page
      .getByRole("button", { name: "Remove theme", exact: true })
      .click();
    await expect(
      fresh.page.getByRole("button", { name: "Use Legacy Dusk for dark mode" }),
    ).toHaveCount(0);
    await before.goto("/settings/appearance");
    await expect(
      before.getByRole("button", {
        name: "Use Nimbus for dark mode",
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      before.getByRole("button", { name: "Use Legacy Dusk for dark mode" }),
    ).toHaveCount(0);
  } finally {
    await fresh.context.close();
    await legacy.close();
  }
});
