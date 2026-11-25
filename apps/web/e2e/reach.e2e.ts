import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { FileAction, type FileView } from "../app/drive/files/file-action";
import { Device } from "../lib/device";
import { z } from "zod";
import { client, login, origin, password, port, test } from "./helpers";

/**
 * Every file action has a visible route in every view, at every size, with a finger and with a
 * mouse: a button, a link, an item in a menu or a drawer, the selection bar, or a gesture that
 * selects. Which route does not matter. What should be reachable is `FileAction.all`, less what
 * `FileAction.unavailable` declares with its reason; an undeclared gap fails, and so does a
 * declared one that turns out reachable.
 *
 * The seed is made once. Each view loads once per size, and its surfaces are opened and closed
 * in place rather than reloaded.
 */

const sizes = {
  phone: { width: 390, height: 844 },
  tablet: { width: 950, height: 800 },
  desktop: { width: 1280, height: 720 },
} as const;
type Size = keyof typeof sizes;

/** A mouse runs at every size; a finger at its own project's size and, on a tablet, wider. */
function sizesFor(project: string): readonly Size[] {
  if (project === "mobile") return ["phone"];
  if (project === "tablet") return ["tablet", "desktop"];
  return ["phone", "tablet", "desktop"];
}

type Seed = {
  id: string;
  top: string;
  folder: string;
  files: readonly [string, string];
  memberState: Awaited<ReturnType<BrowserContext["storageState"]>>;
};

let seed: Seed | null = null;

async function makeSeed(browser: Browser): Promise<Seed> {
  const id = randomUUID().slice(0, 8);
  const top = `reach-${id}`;
  const folder = `maps-${id}`;
  const files = [`trail-notes-${id}.txt`, `packing-list-${id}.txt`] as const;
  const admin = await browser.newContext({
    baseURL: origin,
    storageState: "test-results/.auth/admin.json",
  });
  try {
    const rpc = await client(admin);
    await rpc.files.createFolder.mutate({ name: top });
    await rpc.files.createFolder.mutate({ path: top, name: folder });
    const { dataRoot } = z
      .object({ dataRoot: z.string() })
      .parse(
        JSON.parse(
          await readFile(
            path.join(os.tmpdir(), `nimbus-e2e-${port}.json`),
            "utf8",
          ),
        ),
      );
    for (const name of files)
      await writeFile(path.join(dataRoot, top, name), `Notes for ${name}`);
    await rpc.files.createFolder.mutate({ path: top, name: `old-${id}` });
    await rpc.files.delete.mutate({ path: `${top}/old-${id}` });
    const items = [
      `${top}/${folder}`,
      ...files.map((file) => `${top}/${file}`),
    ];
    for (const item of items) {
      await rpc.catalog.bookmark.mutate({ path: item, starred: true });
      await rpc.catalog.bookmark.mutate({ path: item });
    }
    // Shared with me lists what other accounts share: a member is given the same three items.
    const email = `reach-${id}@nimbus.test`;
    const created = await admin.request.post("/api/auth/admin/create-user", {
      headers: { Origin: origin },
      data: { name: "Reach Member", email, password, role: "user" },
    });
    expect(created.ok()).toBe(true);
    const body: unknown = await created.json();
    const memberId =
      typeof body === "object" &&
      body !== null &&
      "user" in body &&
      typeof body.user === "object" &&
      body.user !== null &&
      "id" in body.user &&
      typeof body.user.id === "string"
        ? body.user.id
        : null;
    if (!memberId) throw new Error("Creating the reach member returned no id.");
    for (const item of items)
      await rpc.access.grant.mutate({
        path: item,
        subject: { type: "user", id: memberId },
        permission: "admin",
      });
    const member = await browser.newContext({
      baseURL: origin,
      storageState: { cookies: [], origins: [] },
    });
    try {
      await login(await member.newPage(), email);
      return {
        id,
        top,
        folder,
        files,
        memberState: await member.storageState(),
      };
    } finally {
      await member.close();
    }
  } finally {
    await admin.close();
  }
}

const roles =
  "button|link|menuitem|menuitemcheckbox|menuitemradio|combobox|searchbox|tab|option|switch|checkbox|radio";
const namedLine = new RegExp(`^\\s*- (${roles}) "((?:[^"\\\\]|\\\\.)*)"(.*)$`);

/** The enabled controls a person can see now, as `role "name"`, from the accessibility tree. */
async function visibleControls(page: Page) {
  const tree = await page.locator("body").ariaSnapshot();
  const found: { role: string; name: string }[] = [];
  for (const line of tree.split("\n")) {
    const match = namedLine.exec(line);
    if (!match || match[3]?.includes("[disabled]")) continue;
    found.push({
      role: match[1] ?? "",
      name: (match[2] ?? "").replaceAll('\\"', '"'),
    });
  }
  return found;
}

async function deviceOf(page: Page) {
  const answers = await page.evaluate(
    (queries) =>
      Object.fromEntries(queries.map((q) => [q, matchMedia(q).matches])),
    Object.values(Device.query),
  );
  return Device.read((query) => answers[query] === true);
}

const viewPath = (view: FileView, s: Seed) =>
  view === "files list" || view === "files grid"
    ? `/browse/${s.top}`
    : view === "search results"
      ? `/search?q=${s.id}`
      : `/${view}`;

/** Closes whatever surface is open, as Escape does, and waits for it to go. */
async function closeSurfaces(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

/** Selects one item, then a second, with the device's own gesture; true when each worked. */
async function selectWithGesture(
  page: Page,
  rows: readonly [Locator, Locator],
  pointer: "coarse" | "fine" | "none",
) {
  const bar = page.getByRole("toolbar", { name: "Selected items" });
  const [first, second] = rows;
  if (pointer === "coarse") {
    const point = {
      clientX: 40,
      clientY: 40,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
    };
    await first.dispatchEvent("pointerdown", point);
    await page.waitForTimeout(550);
    await first.dispatchEvent("pointerup", point);
    await first.dispatchEvent("click", point);
  } else {
    await first.hover();
    await first.locator("[data-entry-check]").click();
  }
  const one = await bar
    .filter({ hasText: "1 selected" })
    .waitFor({ timeout: 5_000 })
    .then(
      () => true,
      () => false,
    );
  if (!one) return { one, many: false };
  if (pointer === "coarse") await second.tap();
  else {
    await second.hover();
    await second.locator("[data-entry-check]").click();
  }
  const many = await bar
    .filter({ hasText: "2 selected" })
    .waitFor({ timeout: 5_000 })
    .then(
      () => true,
      () => false,
    );
  return { one, many };
}

/** Every route to every action in `view`, as the names of what a person can see and use. */
async function routesIn(page: Page, view: FileView, s: Seed) {
  const device = await deviceOf(page);
  /** What a person can see and use, by accessible name: its role, and where it was. */
  const seen = new Map<string, { role: string; where: string }>();
  const note = (where: string, controls: { role: string; name: string }[]) => {
    for (const { role, name } of controls)
      if (!seen.has(name)) seen.set(name, { role, where });
  };
  note("the page", await visibleControls(page));

  const grid = page.getByRole("grid").first();
  const entries = view !== "trash" && (await grid.count()) > 0;
  const gestures = { one: false, many: false };
  /** Open and preview by the entry itself: a folder's link, and a file's own row. */
  const rows = { open: false, preview: false };
  if (entries) {
    const row = (name: string) =>
      grid.locator(`[data-entry-name="${name}"]`).first();
    // Open: the folder's own link, and a file's own row, which opens its preview.
    rows.open = await row(s.folder).isVisible();
    rows.preview = await row(s.files[0]).isVisible();
    const actions = page.getByRole("button", {
      name: `Actions for ${s.files[0]}`,
      exact: true,
    });
    if (await actions.count()) {
      await row(s.files[0]).hover({ trial: device.pointer === "coarse" });
      if (device.pointer === "coarse") await actions.tap();
      else await actions.click();
      await page
        .getByRole("menu")
        .or(page.getByRole("dialog"))
        .first()
        .waitFor();
      note("the item's actions", await visibleControls(page));
      await closeSurfaces(page);
    }
    // Opening the actions selected the item: start the gestures from nothing selected.
    const bar = page.getByRole("toolbar", { name: "Selected items" });
    if (await bar.isVisible())
      await bar.getByRole("button", { name: "Clear selection" }).click();
    await expect(bar).toHaveCount(0);
    Object.assign(
      gestures,
      await selectWithGesture(
        page,
        [row(s.files[0]), row(s.files[1])],
        device.pointer,
      ),
    );
    if (gestures.many) note("the selection bar", await visibleControls(page));
    await page.keyboard.press("Escape");
  }

  // New: in the sidebar, or a floating button on narrow screens. In a folder, a folded sidebar
  // is opened to look for it; the sidebar's toggle is itself a visible route.
  const newButton = page
    .getByRole("button", { name: /^(New|New file or folder)$/ })
    .filter({ visible: true });
  const toggle = page.getByRole("button", {
    name: "Toggle Sidebar",
    exact: true,
  });
  const folder = view === "files list" || view === "files grid";
  let toggled = false;
  if (folder && (await newButton.count()) === 0 && (await toggle.isVisible())) {
    await toggle.click();
    toggled = true;
    await newButton
      .first()
      .waitFor({ timeout: 2_000 })
      .catch(() => {});
  }
  if ((await newButton.count()) > 0 && (await newButton.first().isEnabled())) {
    await newButton.first().click();
    await page.getByRole("menu").or(page.getByRole("dialog")).first().waitFor();
    note("the New menu", await visibleControls(page));
    await closeSurfaces(page);
  }
  if (toggled && (await toggle.isVisible())) await toggle.click();
  else if (toggled) await page.keyboard.press("Escape");

  return { device, seen, gestures, rows };
}

function reached(
  action: FileAction,
  routes: Awaited<ReturnType<typeof routesIn>>,
): string | null {
  if (action === "select one")
    return routes.gestures.one ? "the device's select gesture" : null;
  if (action === "select many")
    return routes.gestures.many ? "the device's select gesture, twice" : null;
  if (action === "open" && routes.rows.open) return "the folder's own link";
  if (action === "preview" && routes.rows.preview) return "the file's own row";
  // Links go places; the actions are controls, so a link to Trash is not the trash action.
  for (const [name, { role, where }] of routes.seen)
    if (
      role !== "link" &&
      FileAction.names[action].some((pattern) => pattern.test(name))
    )
      return `"${name}" (${role} in ${where})`;
  return null;
}

test.beforeAll(async ({ browser }) => {
  seed = await makeSeed(browser);
});

for (const view of FileAction.views)
  test(`every action is reachable in ${view}`, async ({
    browser,
    page,
    hasTouch,
    isMobile,
  }, testInfo) => {
    if (!seed)
      throw new Error("The reach seed was not made before the tests ran.");
    const s = seed;
    const rpc = await client(page.context());
    await rpc.prefs.set.mutate({
      view: view === "files grid" ? "grid" : "list",
      sortField: "name",
      sortDirection: "asc",
      groupByType: true,
    });
    // Shared with me is seen by the member the items were shared with.
    const member =
      view === "shared"
        ? await browser.newContext({
            baseURL: origin,
            storageState: s.memberState,
            hasTouch,
            isMobile,
          })
        : null;
    const viewer = member ? await member.newPage() : page;
    const problems: string[] = [];
    try {
      for (const size of sizesFor(testInfo.project.name)) {
        await viewer.setViewportSize(sizes[size]);
        await viewer.goto(viewPath(view, s));
        if (view === "trash")
          await expect(
            viewer.getByRole("heading", { name: "Trash" }),
          ).toBeVisible();
        else
          await expect(
            viewer.locator(`[data-entry-name="${s.files[0]}"]`).first(),
          ).toBeVisible();
        const routes = await routesIn(viewer, view, s);
        for (const action of FileAction.all) {
          const route = reached(action, routes);
          const gap = FileAction.unavailable(action, view);
          if (route && gap)
            problems.push(
              `${size}: "${action}" is declared unavailable (${gap}) but is reachable through ${route}. Remove the declaration from FileAction.unavailable.`,
            );
          if (!route && !gap)
            problems.push(
              `${size}: "${action}" has no visible route. Seen: ${[...routes.seen.keys()].join(", ")}`,
            );
        }
      }
    } finally {
      await member?.close();
    }
    expect(problems, `Undeclared gaps in ${view}`).toEqual([]);
  });

// TODO(split view): once the split view's reach rule is exported (the work on its gates and the
// swipe between panes on phones), add "open split view", "close split view" and "move to the other
// pane" here, reading that rule for where each is offered. Do not guess its API before it lands.
test.fixme("split view actions are reachable where the split rule offers them", () => {});
