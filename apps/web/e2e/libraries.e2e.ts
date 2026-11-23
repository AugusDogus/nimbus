import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { z } from "zod";
import { client, test, upload } from "./helpers";

const started = z.object({
  deviceCode: z.string(),
  pairingCode: z.string(),
  verificationUrlComplete: z.string(),
});
const approved = z.object({
  status: z.literal("approved"),
  token: z.string(),
  library: z.object({ id: z.string(), title: z.string() }),
});
const library = z.object({
  items: z.array(z.object({ name: z.string(), path: z.string() })),
});

test("a library is created in Settings and a device is paired, listed and disconnected", async ({
  page,
  context,
  request,
}) => {
  const folder = `Kitchen ${randomUUID().slice(0, 8)}`;
  await (await client(context)).files.createFolder.mutate({ name: folder });
  await page.goto(`/browse/${encodeURIComponent(folder)}`);
  await upload(page, "Sourdough basics.md", "# Sourdough basics");

  // Settings, Libraries: a library of that folder, chosen with the folder chooser.
  await page.goto("/settings/libraries");
  await expect(
    page.getByRole("heading", { name: "Libraries", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New library" }).click();
  const editor = page.getByRole("dialog");
  await editor.getByLabel("Name").fill(folder);
  await editor.getByRole("button", { name: "Add folder" }).click();
  await editor.getByRole("button", { name: folder }).click();
  await editor.getByRole("button", { name: "Choose this folder" }).click();
  await expect(
    editor.getByRole("list", { name: "Library folders" }),
  ).toContainText(folder);
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toBeHidden();
  await expect(page.getByRole("list", { name: "Libraries" })).toContainText(
    folder,
  );

  // The device starts pairing and the owner approves its code on the pairing page.
  const start = await request.post("/api/library/v1/pair/start", {
    data: { deviceName: "Media box" },
  });
  expect(start.status()).toBe(200);
  const pairing = started.parse(await start.json());
  await page.goto(
    new URL(pairing.verificationUrlComplete).pathname +
      new URL(pairing.verificationUrlComplete).search,
  );
  await expect(
    page.getByRole("heading", { name: "Pair a device" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("“Media box”")).toBeVisible();
  await expect(page.getByText("Name supplied by the device")).toBeVisible();
  await expect(page.getByTestId("pairing-code")).toHaveText(
    pairing.pairingCode,
  );
  await expect(
    page.getByText("Approve only a code shown on a device you are setting up"),
  ).toBeVisible();
  // Several libraries may exist by now: choose this one.
  await page.getByLabel("Library").click();
  await page.getByRole("option", { name: folder }).click();
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByRole("status")).toContainText("“Media box” is paired");

  const poll = await request.post("/api/library/v1/pair/poll", {
    data: { deviceCode: pairing.deviceCode },
  });
  const { token } = approved.parse(await poll.json());
  const headers = { authorization: `Bearer ${token}` };
  const listed = library.parse(
    await (await request.get("/api/library/v1/library", { headers })).json(),
  );
  expect(listed.items).toEqual([
    expect.objectContaining({
      name: "Sourdough basics.md",
      path: "Sourdough basics.md",
    }),
  ]);

  // Settings lists the device; it shows the device gone only once the server has disconnected it.
  await page.goto("/settings/libraries");
  const devices = page.getByRole("list", { name: "Paired devices" });
  const row = devices.getByRole("listitem").filter({ hasText: folder });
  await expect(row).toContainText("Media box");
  // An open dialog hides the page from role queries, so rows are found by markup here.
  const rows = page
    .locator('ul[aria-label="Paired devices"] > li')
    .filter({ hasText: folder });
  let attempts = 0;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/trpc/libraries.revokeDevice*", async (route) => {
    attempts += 1;
    // The first attempt fails; the second is held until the test lets it through.
    if (attempts === 1) return route.fulfill({ status: 500, body: "" });
    await held;
    return route.continue();
  });
  const dialog = page.getByRole("alertdialog");
  await row.getByRole("button", { name: "Disconnect" }).click();
  await dialog.getByRole("button", { name: "Disconnect" }).click();
  await expect(dialog.getByRole("alert")).toContainText("still connected");
  await expect(rows).toHaveCount(1);
  expect((await request.get("/api/library/v1/me", { headers })).status()).toBe(
    200,
  );
  await dialog.getByRole("button", { name: "Disconnect" }).click();
  await expect(
    dialog.getByRole("button", { name: "Disconnecting…" }),
  ).toBeDisabled();
  await expect(rows).toHaveCount(1);
  release();
  await expect(dialog).toBeHidden();
  await expect(rows).toHaveCount(0);
  const me = await request.get("/api/library/v1/me", { headers });
  expect(me.status()).toBe(401);
  expect(await me.json()).toMatchObject({ error: { code: "token_revoked" } });

  // Deleting the library: a failed attempt keeps it listed and says so.
  const libraryRows = page
    .locator('ul[aria-label="Libraries"] > li')
    .filter({ hasText: folder });
  let deletes = 0;
  await page.route("**/api/trpc/libraries.deleteLibrary*", (route) => {
    deletes += 1;
    return deletes === 1
      ? route.fulfill({ status: 500, body: "" })
      : route.continue();
  });
  await libraryRows.getByRole("button", { name: "Delete" }).click();
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(dialog.getByRole("alert")).toContainText("unchanged");
  await expect(libraryRows).toHaveCount(1);
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(dialog).toBeHidden();
  await expect(libraryRows).toHaveCount(0);
});

test("the pairing page needs a sign-in and returns to the code afterwards", async ({
  browser,
}) => {
  const signedOut = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const page = await signedOut.newPage();
  await page.goto("/pair?code=B7KD-M4Q9");
  await expect(page).toHaveURL(/\/login\?/);
  expect(new URL(page.url()).searchParams.get("callbackURL")).toBe(
    "/pair?code=B7KD-M4Q9",
  );
  await signedOut.close();
});
