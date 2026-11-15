import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { test } from "./helpers";

/**
 * A minimal stand-in for the WebMCP draft API (document.modelContext): tools
 * register with an AbortSignal that unregisters them, and the test plays the
 * in-browser agent by calling execute directly.
 */
const installModelContext = () => {
  type Tool = { name: string; execute: (input: object, options: { signal: AbortSignal }) => unknown };
  const tools = new Map<string, Tool>();
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value: {
      async registerTool(tool: Tool, options?: { signal?: AbortSignal }) {
        if (tools.has(tool.name)) throw new DOMException(`${tool.name} is already registered`, "InvalidStateError");
        tools.set(tool.name, tool);
        options?.signal?.addEventListener("abort", () => tools.delete(tool.name));
      },
    },
  });
  Object.defineProperty(window, "agent", {
    value: {
      names: () => [...tools.keys()].sort(),
      call: async (name: string, input: object) => {
        const tool = tools.get(name);
        if (!tool) throw new Error(`No tool ${name}`);
        return JSON.parse(JSON.stringify(await tool.execute(input, { signal: new AbortController().signal })));
      },
    },
  });
};

const toolNames = (page: Page) => page.evaluate(() => Reflect.get(window, "agent").names());
const callTool = (page: Page, name: string, input: object) =>
  page.evaluate(([tool, args]) => Reflect.get(window, "agent").call(tool, args), [name, input] as const);

test("the folder view offers page tools to in-browser agents that act through the page", async ({ page }) => {
  await page.addInitScript(installModelContext);
  await page.goto("/");
  await expect.poll(() => toolNames(page)).toEqual([
    "nimbus.create_folder",
    "nimbus.list_folder",
    "nimbus.open_folder",
    "nimbus.open_preview",
    "nimbus.search",
    "nimbus.start_move",
    "nimbus.start_rename",
  ]);

  expect(await callTool(page, "nimbus.list_folder", {})).toMatchObject({ ok: true, folder: "", entries: expect.arrayContaining([expect.objectContaining({ name: "alpha.txt", type: "file" })]) });
  expect(await callTool(page, "nimbus.search", { query: "readme" })).toMatchObject({ ok: true, entries: [{ path: "docs/readme.md" }] });

  await callTool(page, "nimbus.open_preview", { path: "alpha.txt" });
  await expect(page.getByRole("dialog", { name: "alpha.txt" })).toBeVisible();
  await page.keyboard.press("Escape");

  expect(await callTool(page, "nimbus.start_rename", { path: "alpha.txt" })).toMatchObject({ ok: true });
  const rename = page.getByRole("dialog");
  await expect(rename.getByRole("textbox")).toHaveValue("alpha.txt");
  await rename.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator('[data-entry-name="alpha.txt"]').filter({ visible: true })).toBeVisible();

  const folder = `agent-${randomUUID().slice(0, 8)}`;
  expect(await callTool(page, "nimbus.create_folder", { name: folder })).toMatchObject({ ok: true, path: folder });
  await expect(page.getByRole("link", { name: folder, exact: true })).toBeVisible();
  expect(await callTool(page, "nimbus.open_preview", { path: "missing.txt" })).toMatchObject({ ok: false });

  await callTool(page, "nimbus.open_folder", { path: "docs" });
  await expect(page).toHaveURL(/\/browse\/docs$/);
  await expect.poll(async () => JSON.stringify(await callTool(page, "nimbus.list_folder", {}))).toContain("readme.md");

  await page.goto("/settings/appearance");
  await expect.poll(() => toolNames(page)).toEqual([]);
});

test("browsers without WebMCP never download the page tools", async ({ page }) => {
  const scripts: Promise<string>[] = [];
  page.on("response", (response) => {
    if (response.request().resourceType() === "script") scripts.push(response.text().catch(() => ""));
  });
  await page.goto("/");
  await expect(page.locator('[data-entry-name="alpha.txt"]').filter({ visible: true })).toBeVisible();
  expect(await page.evaluate(() => "modelContext" in document)).toBe(false);
  const bodies = await Promise.all(scripts);
  expect(bodies.length).toBeGreaterThan(0);
  expect(bodies.filter((body) => body.includes("nimbus.start_rename"))).toEqual([]);
});
