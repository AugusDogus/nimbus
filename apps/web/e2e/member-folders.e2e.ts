import { randomUUID } from "node:crypto";
import {
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import type { Permission } from "@nimbus/api/drive-store";
import { client, login, origin, password, test } from "./helpers";

/**
 * Signs a new member account in on its own page, after the administrator in `context` grants it
 * `grants`. Folders named in them must exist. Close the returned context when done.
 */
async function asMember(
  browser: Browser,
  context: BrowserContext,
  page: Page,
  isMobile: boolean,
  grants: { path: string; permission: Permission }[],
) {
  const email = `member-${randomUUID()}@nimbus.test`;
  const created = await context.request.post("/api/auth/admin/create-user", {
    headers: { Origin: origin },
    data: { name: "Folder Member", email, password, role: "user" },
  });
  expect(created.ok()).toBe(true);
  const body: unknown = await created.json();
  const id =
    typeof body === "object" &&
    body !== null &&
    "user" in body &&
    typeof body.user === "object" &&
    body.user !== null &&
    "id" in body.user &&
    typeof body.user.id === "string"
      ? body.user.id
      : null;
  if (!id) throw new Error("Creating the member returned no user id.");
  const rpc = await client(context);
  for (const { path, permission } of grants)
    await rpc.access.grant.mutate({
      path,
      subject: { type: "user", id },
      permission,
    });
  const memberContext = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: page.viewportSize(),
    isMobile,
    hasTouch: isMobile,
  });
  const member = await memberContext.newPage();
  await login(member, email);
  return { member, memberContext };
}

test("an empty folder the account can only read does not suggest adding to it", async ({
  browser,
  context,
  page,
  isMobile,
}) => {
  const folder = `read-only-${randomUUID()}`;
  await (await client(context)).files.createFolder.mutate({ name: folder });
  const { member, memberContext } = await asMember(
    browser,
    context,
    page,
    isMobile,
    [{ path: folder, permission: "read" }],
  );
  try {
    await member.goto(`/browse/${folder}`);
    await expect(member.getByText("This folder is empty")).toBeVisible();
    await expect(
      member.getByText("You can view this folder but not add to it."),
    ).toBeVisible();
    await expect(member.getByText(/Drop files here|Tap New/)).toBeHidden();
  } finally {
    await memberContext.close();
  }
});
