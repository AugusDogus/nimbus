import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { asMember, client, test } from "./helpers";

// Wherever Nimbus says where an item is, it names the place as the person's breadcrumb does:
// their top folder (their home, for an account that reaches nothing else) as Files, never the
// folder that holds every home or the home's own name.

test("a member limited to their home sees its items in Files, in search, its suggestions and Trash", async ({
  page,
  context,
  browser,
  isMobile,
}) => {
  const tag = `loc${randomUUID().slice(0, 8)}`;
  const { member, memberContext, home } = await asMember(
    browser,
    context,
    page,
    isMobile,
    [],
  );
  try {
    const rpc = await client(memberContext);
    await rpc.files.createFolder.mutate({ path: home, name: "Travel" });
    await rpc.files.createFolder.mutate({
      path: `${home}/Travel`,
      name: `${tag} itinerary`,
    });
    await rpc.files.createFolder.mutate({
      path: `${home}/Travel`,
      name: `${tag} old`,
    });
    await rpc.files.delete.mutate({ path: `${home}/Travel/${tag} old` });

    await member.goto(`/search?q=${tag}%20itinerary`);
    const row = member
      .locator(`[data-entry-name="${tag} itinerary"]`)
      .filter({ visible: true });
    await expect(row).toContainText("Files / Travel");
    await expect(row).not.toContainText(home);

    if (!isMobile) {
      await member.goto("/");
      await member
        .getByRole("combobox", { name: "Search files" })
        .fill(`${tag} itinerary`);
      const suggestion = member
        .getByRole("option", { name: `${tag} itinerary`, exact: false })
        .filter({ hasNotText: "Show all results" });
      await expect(suggestion).toContainText("Files / Travel");
      await expect(suggestion).not.toContainText(home);
    }

    await member.goto("/trash");
    const deleted = member
      .locator("[data-trash-item]")
      .filter({ hasText: `${tag} old` });
    await expect(deleted).toContainText("Files / Travel");
    await expect(deleted).not.toContainText(home);
  } finally {
    await memberContext.close();
  }
});

test("an administrator sees a member's home where it is, and a visitor to a link inside it sees no home", async ({
  page,
  context,
  browser,
  isMobile,
}) => {
  const tag = `loc${randomUUID().slice(0, 8)}`;
  const { memberContext, home } = await asMember(
    browser,
    context,
    page,
    isMobile,
    [],
  );
  try {
    const rpc = await client(memberContext);
    await rpc.files.createFolder.mutate({ path: home, name: `${tag} trip` });
    // The administrator's Files is the drive root, so the home reads from there.
    await page.goto(`/search?q=${tag}%20trip`);
    await expect(
      page.locator(`[data-entry-name="${tag} trip"]`).filter({ visible: true }),
    ).toContainText(`Files / ${home.split("/").join(" / ")}`);

    const { token } = await rpc.shares.create.mutate({
      path: `${home}/${tag} trip`,
      expiresAt: null,
    });
    const anonymous = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    try {
      const visitor = await anonymous.newPage();
      await visitor.goto(`/s/${token}`);
      await expect(visitor.getByText(`${tag} trip`).first()).toBeVisible();
      const [, homeName = home] = home.split("/");
      await expect(visitor.locator("body")).not.toContainText(homeName);
    } finally {
      await anonymous.close();
    }
  } finally {
    await memberContext.close();
  }
});
