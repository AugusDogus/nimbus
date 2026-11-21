import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";
import { FileListing } from "@nimbus/api/file-listing";
import { asMember, client, test } from "./helpers";

const trail = (page: Page) => page.locator('nav[aria-label="breadcrumb"]');

/** Drags `source` over `target` with the mouse, then drops it there once `check` passes. */
async function dragOnto(
  page: Page,
  source: Locator,
  target: Locator,
  check: (target: Locator) => Promise<void> = async () => {},
) {
  await source.hover();
  await page.mouse.down();
  await target.hover();
  await target.hover();
  await check(target);
  await page.mouse.up();
}

test.describe("dropping on the breadcrumb", () => {
  test.skip(({ isMobile }) => isMobile, "Touch moves items with Move to….");

  test("moves items up to the parent or to Files, and to a hidden folder through …", async ({
    page,
    context,
  }) => {
    const top = `crumbs-${randomUUID()}`;
    const rpc = await client(context);
    const names = async (path: string) =>
      FileListing.entries(await rpc.files.list.query({ path })).map(
        (entry) => entry.name,
      );
    await rpc.files.createFolder.mutate({ name: top });
    let path = top;
    for (const level of ["one", "two", "three"]) {
      await rpc.files.createFolder.mutate({ path, name: level });
      path = `${path}/${level}`;
    }
    for (const name of ["Up a level", "To the root", "To the top"])
      await rpc.files.createFolder.mutate({ path, name });
    await page.goto(`/browse/${path}`);
    const row = (name: string) =>
      page.getByRole("link", { name, exact: true }).first();

    // The parent shows beside the current folder from 1024 px.
    await dragOnto(
      page,
      row("Up a level"),
      trail(page).getByRole("link", { name: "two", exact: true }),
      async (target) => {
        await expect(target).toHaveAttribute("data-drop-target", "true");
        await expect(
          page.getByRole("status").filter({ hasText: "Move to “two”" }),
        ).toBeVisible();
      },
    );
    await expect.poll(() => names(`${top}/one/two`)).toContain("Up a level");

    await dragOnto(
      page,
      row("To the root"),
      trail(page).getByRole("link", { name: "Files", exact: true }),
    );
    await expect.poll(() => names("")).toContain("To the root");
    await rpc.files.delete.mutate({ path: "To the root" });

    // Hovering … while dragging opens the folders it hides.
    await row("To the top").hover();
    await page.mouse.down();
    const more = trail(page).getByRole("button", {
      name: "Show folders in this path",
    });
    await more.hover();
    await more.hover();
    const hidden = page.getByRole("menuitem", { name: top, exact: true });
    await expect(hidden).toBeVisible();
    await hidden.hover();
    await hidden.hover();
    await expect(hidden).toHaveAttribute("data-drop-target", "true");
    await page.mouse.up();
    await expect.poll(() => names(top)).toContain("To the top");
    await expect(hidden).toBeHidden();
    await expect(row("To the top")).toHaveCount(0);
  });

  test("refuses a folder the account cannot write to, and uploads files from the computer to one it can", async ({
    browser,
    context,
    page,
    isMobile,
  }) => {
    const top = `crumb-rights-${randomUUID()}`;
    const rpc = await client(context);
    await rpc.files.createFolder.mutate({ name: top });
    await rpc.files.createFolder.mutate({ path: top, name: "mine" });
    await rpc.files.createFolder.mutate({ path: `${top}/mine`, name: "inner" });
    await rpc.files.createFolder.mutate({
      path: `${top}/mine/inner`,
      name: "Stays",
    });
    const { member, memberContext } = await asMember(
      browser,
      context,
      page,
      isMobile,
      [{ path: `${top}/mine`, permission: "admin" }],
    );
    try {
      await member.goto(`/browse/${top}/mine/inner`);
      const source = member.getByRole("link", { name: "Stays", exact: true });
      // The account only passes through the folder above its grant.
      await member.setViewportSize({ width: 1440, height: 900 });
      await dragOnto(
        member,
        source,
        trail(member).getByRole("link", { name: "Files", exact: true }),
        async (target) => {
          await expect(target).toHaveAttribute("data-drop-target", "refused");
          await expect(
            member
              .getByRole("status")
              .filter({ hasText: "You can only view “Files”" }),
          ).toBeVisible();
        },
      );
      await expect(source).toBeVisible();
      expect(
        FileListing.entries(
          await rpc.files.list.query({ path: `${top}/mine/inner` }),
        ).map((entry) => entry.name),
      ).toEqual(["Stays"]);

      const files = await member.evaluateHandle(() => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(["From the desktop."], "dropped.txt"));
        return transfer;
      });
      const parent = trail(member).getByRole("link", {
        name: "mine",
        exact: true,
      });
      await parent.dispatchEvent("dragover", { dataTransfer: files });
      await expect(
        member.getByRole("status").filter({ hasText: "Upload to “mine”" }),
      ).toBeVisible();
      await parent.dispatchEvent("drop", { dataTransfer: files });
      await expect
        .poll(async () =>
          FileListing.entries(
            await rpc.files.list.query({ path: `${top}/mine` }),
          ).map((entry) => entry.name),
        )
        .toContain("dropped.txt");
    } finally {
      await memberContext.close();
    }
  });
});

test.describe("moving up one level without dragging", () => {
  test.skip(({ isMobile }) => isMobile, "Keyboards and the selection bar.");

  test("moves an item up from its menu by keyboard, and a selection from the selection bar", async ({
    page,
    context,
  }) => {
    const top = `up-${randomUUID()}`;
    const rpc = await client(context);
    const names = async (path: string) =>
      FileListing.entries(await rpc.files.list.query({ path })).map(
        (entry) => entry.name,
      );
    await rpc.files.createFolder.mutate({ name: top });
    await rpc.files.createFolder.mutate({ path: top, name: "inner" });
    for (const name of ["By keyboard", "Selected one", "Selected two"])
      await rpc.files.createFolder.mutate({ path: `${top}/inner`, name });
    await page.goto(`/browse/${top}/inner`);
    const row = (name: string) =>
      page.getByRole("link", { name, exact: true }).first();

    await row("By keyboard").focus();
    await page.keyboard.press("Shift+F10");
    const item = page.getByRole("menuitem", { name: "Move up one level" });
    await expect(item).toBeVisible();
    for (let step = 0; step < 12; step++) {
      if (await item.evaluate((element) => element === document.activeElement))
        break;
      await page.keyboard.press("ArrowDown");
    }
    await expect(item).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => names(top)).toContain("By keyboard");

    const mod = process.platform === "darwin" ? "Meta" : "Control";
    await row("Selected one").click({ modifiers: [mod] });
    await row("Selected two").click({ modifiers: [mod] });
    await page
      .getByRole("toolbar", { name: "Selected items" })
      .getByRole("button", { name: "Move up one level" })
      .click();
    await expect
      .poll(() => names(top))
      .toEqual(
        expect.arrayContaining(["By keyboard", "Selected one", "Selected two"]),
      );
    expect(await names(`${top}/inner`)).toEqual([]);
  });

  test("is not offered in the account's top folder or below a folder it cannot write to", async ({
    browser,
    context,
    page,
    isMobile,
  }) => {
    const top = `no-up-${randomUUID()}`;
    const rpc = await client(context);
    await rpc.files.createFolder.mutate({ name: top });
    await rpc.files.createFolder.mutate({ path: top, name: "mine" });
    await rpc.files.createFolder.mutate({ path: `${top}/mine`, name: "inner" });
    await rpc.files.createFolder.mutate({
      path: `${top}/mine/inner`,
      name: "Item",
    });
    const { member, memberContext, home } = await asMember(
      browser,
      context,
      page,
      isMobile,
      [{ path: `${top}/mine`, permission: "admin" }],
    );
    try {
      const offered = async (address: string, name: string) => {
        await member.goto(address);
        await member.getByRole("link", { name, exact: true }).first().focus();
        await member.keyboard.press("Shift+F10");
        await expect(member.getByRole("menuitem").first()).toBeVisible();
        const count = await member
          .getByRole("menuitem", { name: "Move up one level" })
          .count();
        await member.keyboard.press("Escape");
        return count > 0;
      };
      expect(await offered(`/browse/${top}/mine/inner`, "Item")).toBe(true);
      // The folder above "mine" only leads to it; nothing can go there.
      expect(await offered(`/browse/${top}/mine`, "inner")).toBe(false);
      await (
        await client(memberContext)
      ).files.createFolder.mutate({
        path: home,
        name: "Own",
      });
      expect(await offered(`/browse/${home}`, "Own")).toBe(false);
    } finally {
      await memberContext.close();
    }
  });
});

for (const [width, view] of [
  [768, "list"],
  [1024, "grid"],
  [1440, "list"],
] as const)
  test(`a selection dragged at ${width} px in ${view} view reaches the breadcrumb past the selection bar`, async ({
    page,
    context,
    isMobile,
  }) => {
    test.skip(isMobile, "Touch moves items with Move to….");
    const top = `selected-${randomUUID()}`;
    const rpc = await client(context);
    await rpc.prefs.set.mutate({
      view,
      sortField: "name",
      sortDirection: "asc",
      groupByType: true,
    });
    await rpc.files.createFolder.mutate({ name: top });
    await rpc.files.createFolder.mutate({ path: top, name: "inner" });
    for (const name of ["First", "Second", "Third"])
      await rpc.files.createFolder.mutate({ path: `${top}/inner`, name });
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/browse/${top}/inner`);
    const row = (name: string) =>
      page.locator(`[data-entry-name="${name}"]`).filter({ visible: true });
    const bar = page.getByRole("toolbar", { name: "Selected items" });
    const mod = process.platform === "darwin" ? "Meta" : "Control";
    await row("First").click({ modifiers: [mod] });
    await row("Second").click({ modifiers: [mod] });
    await expect(bar).toBeVisible();

    // A drag let go where nothing takes it brings the bar back, with the selection kept.
    await row("First").hover();
    await page.mouse.down();
    await row("Third").hover();
    await row("Third").hover();
    await expect(bar).toBeHidden();
    await row("First").hover();
    await page.mouse.up();
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("2");

    const root = page
      .locator('nav[aria-label="breadcrumb"]')
      .getByRole("link", { name: "Files", exact: true });
    await row("First").hover();
    await page.mouse.down();
    // The drag starts with the first movement, and the bar steps aside from the breadcrumb.
    await row("Third").hover();
    await expect(bar).toBeHidden();
    await root.hover();
    await root.hover();
    await expect(root).toHaveAttribute("data-drop-target", "true");
    await page.mouse.up();
    await expect
      .poll(async () =>
        FileListing.entries(await rpc.files.list.query({ path: "" })).map(
          (entry) => entry.name,
        ),
      )
      .toEqual(expect.arrayContaining(["First", "Second"]));
    for (const name of ["First", "Second"])
      await rpc.files.delete.mutate({ path: name });
    await rpc.prefs.set.mutate({
      view: "list",
      sortField: "name",
      sortDirection: "asc",
      groupByType: true,
    });
  });

test("files dragged in from the computer open … and upload into a hidden folder", async ({
  page,
  context,
  isMobile,
}) => {
  test.skip(isMobile, "Phones have no files to drag in from a desktop.");
  const top = `spring-files-${randomUUID()}`;
  const rpc = await client(context);
  await rpc.files.createFolder.mutate({ name: top });
  let path = top;
  for (const level of ["one", "two", "three"]) {
    await rpc.files.createFolder.mutate({ path, name: level });
    path = `${path}/${level}`;
  }
  await page.goto(`/browse/${path}`);
  const files = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["From the desktop."], "sprung.txt"));
    return transfer;
  });
  const more = page
    .locator('nav[aria-label="breadcrumb"]')
    .getByRole("button", { name: "Show folders in this path" });
  await more.dispatchEvent("dragenter", { dataTransfer: files });
  await more.dispatchEvent("dragover", { dataTransfer: files });
  await expect(more).toHaveAttribute("aria-expanded", "true");
  const hidden = page.getByRole("menuitem", { name: top, exact: true });
  await hidden.dispatchEvent("dragover", { dataTransfer: files });
  await expect(hidden).toHaveAttribute("data-drop-target", "true");
  await hidden.dispatchEvent("drop", { dataTransfer: files });
  await expect
    .poll(async () =>
      FileListing.entries(await rpc.files.list.query({ path: top })).map(
        (entry) => entry.name,
      ),
    )
    .toContain("sprung.txt");
  await expect(more).toHaveAttribute("aria-expanded", "false");
});

test("a drag says when part of the selection cannot be moved, and moves the rest", async ({
  page,
  context,
  isMobile,
}) => {
  test.skip(isMobile, "Touch moves items with Move to….");
  const top = `partial-${randomUUID()}`;
  const rpc = await client(context);
  await rpc.files.createFolder.mutate({ name: top });
  await page.goto("/");
  const row = (name: string) =>
    page.getByRole("link", { name, exact: true }).first();
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  // The folder holding the home folders never moves.
  await row(top).click({ modifiers: [mod] });
  await row("users").click({ modifiers: [mod] });
  await row(top).hover();
  await page.mouse.down();
  await row("docs").hover();
  await row("docs").hover();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "1 of 2 items cannot be moved from here" }),
  ).toBeVisible();
  await page.mouse.up();
  await expect
    .poll(async () =>
      FileListing.entries(await rpc.files.list.query({ path: "docs" })).map(
        (entry) => entry.name,
      ),
    )
    .toContain(top);
  await rpc.files.move.mutate({
    sourcePath: `docs/${top}`,
    destinationPath: "",
  });
});
