import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { asMember, client, test } from "./helpers";

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

test("a folder the account may not open says so, the same whether or not it exists", async ({
  browser,
  context,
  page,
  isMobile,
}) => {
  const hidden = `not-shared-${randomUUID()}`;
  await (await client(context)).files.createFolder.mutate({ name: hidden });
  const { member, memberContext } = await asMember(
    browser,
    context,
    page,
    isMobile,
    [],
  );
  try {
    for (const folder of [hidden, `missing-${randomUUID()}`]) {
      await member.goto(`/browse/${folder}`);
      // Retrying a refusal only delays the answer by several seconds.
      await expect(
        member.getByRole("heading", {
          name: "You do not have access to this folder",
          exact: true,
        }),
      ).toBeVisible({ timeout: 4_000 });
      await expect(
        member.getByText(
          "Ask a server administrator, or the person who shared it with you, for access.",
        ),
      ).toBeVisible();
      await expect(member.getByText("Could not open this folder")).toBeHidden();
      // New stays, for the member's own home folder.
      await expect(
        member.getByRole("button", {
          name: isMobile ? "New file or folder" : "New",
          exact: true,
        }),
      ).toBeEnabled();
      await expect(
        member
          .getByRole("region", { name: /Notifications/ })
          .getByText("not shared with you"),
      ).toHaveCount(0);
    }
    // A missing folder the account could open is still just missing.
    await member.goto("/home");
    await expect(member).toHaveURL(/\/browse\/users\//);
    await member.goto(
      `${new URL(member.url()).pathname}/missing-${randomUUID()}`,
    );
    await expect(
      member.getByRole("heading", { name: "Folder not found", exact: true }),
    ).toBeVisible();
  } finally {
    await memberContext.close();
  }
});

test("folders shown only as the way to something shared deeper say so, to members only", async ({
  browser,
  context,
  page,
  isMobile,
}) => {
  const top = `documents-${randomUUID()}`;
  const rpc = await client(context);
  await rpc.files.createFolder.mutate({ name: top });
  await rpc.files.createFolder.mutate({ path: top, name: "team" });
  await rpc.files.createFolder.mutate({ path: `${top}/team`, name: "reports" });
  await rpc.files.createFolder.mutate({ path: top, name: "private" });
  const notice = (on: Page) =>
    on.getByText("Only folders leading to items shared with you are shown.");
  const { member, memberContext } = await asMember(
    browser,
    context,
    page,
    isMobile,
    [{ path: `${top}/team/reports`, permission: "read" }],
  );
  try {
    for (const folder of [top, `${top}/team`]) {
      await member.goto(`/browse/${folder}`);
      await expect(notice(member)).toBeVisible();
    }
    await expect(
      member.locator('[data-entry-name="reports"]').first(),
    ).toBeVisible();
    await member.goto(`/browse/${top}/team/reports`);
    await expect(member.getByText("This folder is empty")).toBeVisible();
    await expect(notice(member)).toBeHidden();
    await page.goto(`/browse/${top}`);
    await expect(
      page.locator('[data-entry-name="private"]').first(),
    ).toBeVisible();
    await expect(notice(page)).toBeHidden();
  } finally {
    await memberContext.close();
  }
});
