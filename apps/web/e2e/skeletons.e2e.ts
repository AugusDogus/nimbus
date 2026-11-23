import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { client, test } from "./helpers";

// Every loading state takes the boxes of what replaces it, so nothing moves when content
// arrives. Each check holds a response back, records where the placeholder's parts are, lets the
// response through and records where the page's own parts are. Parts are paired by their
// `data-shape`, and entries by their order.

type Box = { x: number; y: number; width: number; height: number };
type Shapes = Record<string, Box>;

/** The boxes of every visible part, by name: the first of each name, entries numbered. */
function boxes(): Shapes {
  const shapes: Record<
    string,
    { x: number; y: number; width: number; height: number }
  > = {};
  const visible = (element: Element) => {
    const box = element.getBoundingClientRect();
    return (
      box.width > 0 &&
      box.height > 0 &&
      getComputedStyle(element).visibility !== "hidden"
    );
  };
  const put = (name: string, element: Element) => {
    if (name in shapes || !visible(element)) return;
    const { x, y, width, height } = element.getBoundingClientRect();
    shapes[name] = { x, y, width, height };
  };
  const root = document.querySelector("[data-skeleton]") ?? document;
  for (const element of root.querySelectorAll("[data-shape]"))
    put(element.getAttribute("data-shape") ?? "", element);
  // A page's title is the first heading on its card.
  const title = root.querySelector('[data-slot="page-card"] h1');
  if (title) put("page-title", title);
  const entries = [
    ...root.querySelectorAll("[data-entry-placeholder], [data-entry-row]"),
  ]
    .filter(visible)
    .sort((a, b) => {
      const one = a.getBoundingClientRect();
      const other = b.getBoundingClientRect();
      return one.y - other.y || one.x - other.x;
    });
  entries.forEach((entry, index) => put(`entry-${index}`, entry));
  [...root.querySelectorAll("[data-trash-placeholder], [data-trash-item]")]
    .filter(visible)
    .forEach((item, index) => put(`trash-${index}`, item));
  return shapes;
}

/** Parts more than a pixel from where the page puts them, or on one side only. */
function offsets(placeholder: Shapes, loaded: Shapes) {
  const off: string[] = [];
  for (const [name, box] of Object.entries(loaded)) {
    const held = placeholder[name];
    // Placeholders stand in for as many items as fit; more may come, below them.
    if (!held && /^(entry|trash)-/.test(name)) continue;
    if (!held) {
      off.push(`${name}: only on the loaded page`);
      continue;
    }
    const deltas = (["x", "y", "width", "height"] as const)
      .map((key) => [key, held[key] - box[key]] as const)
      .filter(([, delta]) => Math.abs(delta) > 1);
    if (deltas.length > 0)
      off.push(
        `${name}: ${deltas.map(([key, delta]) => `${key} ${delta > 0 ? "+" : ""}${delta.toFixed(1)}`).join(", ")}`,
      );
  }
  for (const name of Object.keys(placeholder))
    // There may also be fewer, or none.
    if (!(name in loaded) && !/^(entry|trash)-/.test(name))
      off.push(`${name}: only on the placeholder`);
  return off;
}

const widths = (isMobile: boolean) =>
  isMobile ? [390] : [1680, 1280, 1024, 768, 390];
const height = (width: number) => (width > 600 ? 1000 : 844);

/** The shapes at each width, resizing the page in turn. */
async function shapesAt(page: Page, at: readonly number[]) {
  const shapes: Record<number, Shapes> = {};
  for (const width of at) {
    await page.setViewportSize({ width, height: height(width) });
    // A resize lays out again in the next frame.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(resolve)),
    );
    shapes[width] = await page.evaluate(boxes);
  }
  return shapes;
}

/** Lets the requests `matches` picks through only once released. */
async function holdBack(
  page: Page,
  matches: (url: URL) => boolean,
): Promise<() => void> {
  const released = Promise.withResolvers<void>();
  await page.route(matches, async (route) => {
    await released.promise;
    await route.fallback();
  });
  return () => released.resolve();
}

function expectInPlace(
  placeholder: Record<number, Shapes>,
  loaded: Record<number, Shapes>,
) {
  const off = Object.keys(loaded).flatMap((width) =>
    offsets(placeholder[Number(width)] ?? {}, loaded[Number(width)] ?? {}).map(
      (line) => `${width} px wide: ${line}`,
    ),
  );
  expect(off, "Parts that move when the page replaces its skeleton").toEqual(
    [],
  );
}

/** A new folder at the drive's root holding eight folders, which list in one section. */
async function folderOfEight(page: Page) {
  const rpc = await client(page.context());
  const name = `skeleton-${randomUUID()}`;
  await rpc.files.createFolder.mutate({ name });
  for (let index = 0; index < 8; index++)
    await rpc.files.createFolder.mutate({
      path: name,
      name: `Folder ${index}`,
    });
  return { rpc, name };
}

/** Checks the page the server sends at `path` against the app that replaces it. */
async function checkServedSkeleton(
  page: Page,
  path: string,
  at: readonly number[],
  loaded: (page: Page) => Promise<void>,
) {
  await page.setViewportSize({ width: at[0] ?? 1280, height: 1000 });
  const release = await holdBack(
    page,
    (url) =>
      url.pathname.startsWith("/assets/index-") && url.pathname.endsWith(".js"),
  );
  await page.goto(path, { waitUntil: "commit" });
  await page.locator("[data-skeleton]").waitFor();
  const placeholder = await shapesAt(page, at);
  release();
  await expect(page.locator("[data-skeleton]")).toHaveCount(0);
  await loaded(page);
  expectInPlace(placeholder, await shapesAt(page, at));
}

const listed = (page: Page) =>
  expect(page.locator("[data-entry-row]").first()).toBeVisible();
// The storage summary arrives after the page, in the shape it held.
const settled = (page: Page) =>
  expect(page.locator('[data-shape="storage"][aria-busy]')).toHaveCount(0);

test.describe("skeletons", () => {
  let restore: (() => Promise<unknown>) | undefined;
  test.afterEach(async () => {
    await restore?.();
    restore = undefined;
  });

  for (const view of ["list", "grid"] as const)
    test(`a folder's served skeleton in ${view} view is where the folder will be`, async ({
      page,
      isMobile,
    }) => {
      const { rpc, name } = await folderOfEight(page);
      const prefs = await rpc.prefs.get.query();
      restore = () => rpc.prefs.set.mutate(prefs);
      await rpc.prefs.set.mutate({ ...prefs, view });
      await checkServedSkeleton(
        page,
        `/browse/${name}`,
        widths(isMobile),
        async (loaded) => {
          await listed(loaded);
          await settled(loaded);
        },
      );
    });

  for (const path of ["/trash", "/recent", "/settings/appearance"])
    test(`the served skeleton of ${path} is where the page will be`, async ({
      page,
      isMobile,
    }) => {
      // Trash with something in it, as its placeholder shows it.
      if (path === "/trash") {
        const { rpc, name } = await folderOfEight(page);
        await rpc.files.delete.mutate({ path: `${name}/Folder 0` });
      }
      await checkServedSkeleton(
        page,
        path,
        widths(isMobile),
        async (loaded) => {
          await expect(loaded.locator("main h1").first()).toBeVisible();
          await settled(loaded);
        },
      );
    });

  for (const view of ["list", "grid"] as const)
    test(`a folder's listing loading in the app in ${view} view is where the listing will be`, async ({
      page,
      isMobile,
    }) => {
      const { rpc, name } = await folderOfEight(page);
      const prefs = await rpc.prefs.get.query();
      restore = () => rpc.prefs.set.mutate(prefs);
      await rpc.prefs.set.mutate({ ...prefs, view });
      const at = widths(isMobile);
      await page.setViewportSize({ width: at[0] ?? 1280, height: 1000 });
      // From a page without a listing, the folder's shows its placeholder while it loads.
      await page.goto("/trash");
      await expect(page.locator("main h1")).toBeVisible();
      const release = await holdBack(page, (url) =>
        url.pathname.includes("files.list"),
      );
      await page.evaluate((href) => {
        history.pushState(null, "", href);
        dispatchEvent(new PopStateEvent("popstate"));
      }, `/browse/${name}`);
      await expect(page.locator("[data-entry-skeleton]")).toBeVisible();
      const placeholder = await shapesAt(page, at);
      release();
      await expect(page.locator("[data-entry-skeleton]")).toHaveCount(0);
      await listed(page);
      expectInPlace(placeholder, await shapesAt(page, at));
    });

  test("a split view's new pane loading is where its listing will be", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "Phones show one folder at a time.");
    const { rpc, name } = await folderOfEight(page);
    const prefs = await rpc.prefs.get.query();
    restore = () => rpc.prefs.set.mutate(prefs);
    await rpc.prefs.set.mutate({ ...prefs, view: "grid" });
    await page.setViewportSize({ width: 1680, height: 1000 });
    await page.goto(`/browse/${name}/Folder%200`);
    await expect(page.getByText("This folder is empty")).toBeVisible();
    const release = await holdBack(page, (url) =>
      url.pathname.includes("files.list"),
    );
    await page.goto(
      `/browse/${name}/Folder%200?right=${encodeURIComponent(name)}`,
    );
    const pane = page.locator('[data-pane="right"]');
    await expect(pane.locator("[data-entry-skeleton]")).toBeVisible();
    const placeholder = await pane.evaluate(paneBoxes);
    release();
    await expect(pane.locator("[data-entry-row]").first()).toBeVisible();
    expectInPlace(
      { 1680: placeholder },
      { 1680: await pane.evaluate(paneBoxes) },
    );
  });
});

/** The pane's title and entries, by name. */
function paneBoxes(pane: Element): Shapes {
  const shapes: Shapes = {};
  const entries = [
    ...pane.querySelectorAll("[data-entry-placeholder], [data-entry-row]"),
  ].sort((a, b) => {
    const one = a.getBoundingClientRect();
    const other = b.getBoundingClientRect();
    return one.y - other.y || one.x - other.x;
  });
  const title = pane.querySelector('[data-shape="section-title"]');
  for (const [name, element] of [
    ["section-title", title],
    ...entries.map((entry, index) => [`entry-${index}`, entry] as const),
  ] as const) {
    if (!element) continue;
    const { x, y, width, height } = element.getBoundingClientRect();
    shapes[name] = { x, y, width, height };
  }
  return shapes;
}
