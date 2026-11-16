import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { test } from "./helpers";
import {
  action,
  client,
  createFolder,
  login,
  password,
  upload,
} from "./helpers";
import { FileListing } from "@nimbus/api/file-listing";

test("administrators create groups and members receive only their granted read or write access", async ({
  page,
  context,
  browser,
  isMobile,
}, testInfo) => {
  const suffix = randomUUID();
  const email = `member-${suffix}@nimbus.test`;
  const name = `Member ${suffix}`;
  const group = `Editors ${suffix}`;
  const folder = `team-${suffix}`;
  const rpc = await client(context);
  await page.goto("/admin");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Initial password").fill(password);
  await page
    .getByRole("dialog", { name: "Create account", exact: true })
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Create account", exact: true }),
  ).toBeHidden();
  const userRow = page
    .getByRole("list", { name: "Users", exact: true })
    .getByRole("listitem")
    .filter({ hasText: email });
  await expect(userRow).toBeVisible();
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await expect(
    page.getByLabel(`${name} (${email})`, { exact: true }),
  ).toBeVisible();
  const createGroup = page.getByRole("dialog", {
    name: "Create group",
    exact: true,
  });
  expect(
    await createGroup.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.getByLabel("Group name").fill(group);
  await page.getByLabel(`${name} (${email})`, { exact: true }).check();
  await page
    .getByRole("dialog", { name: "Create group", exact: true })
    .getByRole("button", { name: "Create group", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Create group", exact: true }),
  ).toBeHidden();
  const groupRow = page
    .getByRole("list", { name: "Groups", exact: true })
    .getByRole("listitem")
    .filter({ hasText: group });
  await expect(groupRow).toContainText("1 member");
  await page.evaluate(async () => {
    window.scrollTo(0, 0);
    document
      .querySelectorAll('[role="dialog"]')
      .forEach((dialog) => dialog.scrollTo(0, 0));
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  await page.screenshot({
    path: testInfo.outputPath("administration.png"),
    fullPage: true,
  });
  await page.goto("/");
  await createFolder(page, folder, isMobile);
  await page.getByRole("link", { name: folder, exact: true }).click();
  await expect(page).toHaveURL(`/browse/${folder}`);
  await expect(
    page.getByRole("heading", { name: "This folder is empty" }),
  ).toBeVisible();
  await upload(page, "team-note.txt", "Members can read this file.");
  await page.goto("/");
  await action(page, folder, "Share", isMobile);
  const sharing = page.getByRole("dialog", {
    name: `Share ${folder}`,
    exact: true,
  });
  await sharing
    .getByRole("combobox", { name: "Person or group", exact: true })
    .click();
  await page
    .getByRole("option", { name: `Group: ${group}`, exact: true })
    .click();
  await sharing
    .getByRole("button", { name: "Grant access", exact: true })
    .click();
  await expect(
    sharing.getByText(`${group} · read`, { exact: true }),
  ).toBeVisible();
  const memberContext = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: page.viewportSize(),
  });
  try {
    const closedSignup = await memberContext.request.post(
      "/api/auth/sign-up/email",
      {
        data: {
          name: "Uninvited",
          email: `uninvited-${suffix}@nimbus.test`,
          password,
        },
      },
    );
    expect(closedSignup.status()).toBe(403);
    const member = await memberContext.newPage();
    await login(member, email);
    const memberRPC = await client(memberContext);
    expect(await memberRPC.access.me.query()).toMatchObject({
      isAdmin: false,
      home: `homes/member-${suffix}`,
    });
    expect(
      FileListing.entries(await memberRPC.files.list.query({}))
        .map((entry) => entry.name)
        .sort(),
    ).toEqual([folder, "homes"].sort());
    expect(
      FileListing.entries(
        await memberRPC.files.list.query({ path: "homes" }),
      ).map((entry) => entry.name),
    ).toEqual([`member-${suffix}`]);
    expect(
      (
        await memberContext.request.get("/api/files/download?path=alpha.txt")
      ).status(),
    ).toBe(403);
    const allowed = await memberContext.request.get(
      `/api/files/download?path=${encodeURIComponent(`${folder}/team-note.txt`)}`,
    );
    expect(allowed.status()).toBe(200);
    expect(await allowed.text()).toBe("Members can read this file.");
    await expect(
      memberRPC.files.createFolder.mutate({ path: folder, name: "forbidden" }),
    ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    await expect(
      memberRPC.access.saveGroup.mutate({
        name: "Unauthorized",
        memberIds: [],
      }),
    ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    await member.goto("/shared");
    await expect(
      member.getByRole("link", { name: folder, exact: true }),
    ).toBeVisible();
    await member.getByRole("link", { name: folder, exact: true }).click();
    await expect(member).toHaveURL(`/browse/${folder}`);
    await expect(
      member.getByRole("button", { name: "Actions for team-note.txt" }),
    ).toBeVisible();
    await expect(
      member.getByRole("button", { name: "team-note.txt", exact: true }),
    ).toHaveAttribute("draggable", "false");
    await member
      .getByRole("button", { name: "Actions for team-note.txt" })
      .click();
    await expect(
      member.getByRole(isMobile ? "button" : "menuitem", {
        name: "Rename",
        exact: true,
      }),
    ).toHaveCount(0);
    await member.reload();
    await sharing
      .getByRole("combobox", { name: "Permission", exact: true })
      .click();
    await page.getByRole("option", { name: "Edit files", exact: true }).click();
    await sharing
      .getByRole("button", { name: "Grant access", exact: true })
      .click();
    await expect(
      sharing.getByText(`${group} · write`, { exact: true }),
    ).toBeVisible();
    await member.reload();
    await createFolder(member, "member-created", isMobile);
    // Touch screens move items through the Move action; a long press selects instead of dragging.
    await expect(
      member.getByRole("button", { name: "team-note.txt", exact: true }),
    ).toHaveAttribute("draggable", isMobile ? "false" : "true");
    await expect(
      member.getByRole("link", { name: "member-created", exact: true }),
    ).toHaveAttribute("draggable", "false");
    expect(
      FileListing.entries(await rpc.files.list.query({ path: folder })).map(
        (entry) => entry.name,
      ),
    ).toContain("member-created");
    await member
      .getByRole("button", { name: "Actions for member-created", exact: true })
      .click();
    await expect(
      member.getByRole(isMobile ? "button" : "menuitem", {
        name: "Rename",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      member.getByRole(isMobile ? "button" : "menuitem", {
        name: "Move",
        exact: true,
      }),
    ).toHaveCount(0);
    await sharing
      .getByRole("button", { name: "Remove access", exact: true })
      .click();
    await expect(
      sharing.getByText(
        "No direct grants. Parent folder permissions still apply.",
      ),
    ).toBeVisible();
    expect(
      (
        await memberContext.request.get(
          `/api/files/download?path=${encodeURIComponent(`${folder}/team-note.txt`)}`,
        )
      ).status(),
    ).toBe(403);
    await member.goto("/settings/account");
    await expect(
      member.getByRole("heading", { name: "Account", exact: true }),
    ).toBeVisible();
    if (isMobile)
      await member
        .getByRole("button", { name: "Toggle Sidebar", exact: true })
        .click();
    await expect(
      member
        .getByRole("navigation", { name: "Settings", exact: true })
        .getByRole("link", { name: "Users & groups", exact: true }),
    ).toHaveCount(0);
    await member.goto("/settings/admin");
    await expect(
      member
        .getByRole("alert")
        .filter({ hasText: "Only server administrators" }),
    ).toBeVisible();
    await member.goto("/admin");
    await expect(
      member
        .getByRole("alert")
        .filter({ hasText: "Only server administrators" }),
    ).toBeVisible();
  } finally {
    await memberContext.close();
  }
  await page.goto("/admin");
  await groupRow.getByRole("button", { name: "Edit", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit group", exact: true });
  await expect(
    edit.getByRole("button", { name: "Save group", exact: true }),
  ).toBeVisible();
  await expect(
    edit.getByLabel(`${name} (${email})`, { exact: true }),
  ).toBeChecked();
  await edit.getByRole("button", { name: "Save group", exact: true }).click();
  await expect(edit).toBeHidden();
  await groupRow.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("alertdialog", { name: "Delete group and revoke its access?" })
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(groupRow).toBeVisible();
  await groupRow.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("alertdialog", { name: "Delete group and revoke its access?" })
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect(groupRow).toHaveCount(0);
  await userRow
    .getByRole("button", { name: `Actions for ${email}`, exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Make admin", exact: true }).click();
  expect(
    await page
      .getByRole("alertdialog")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect(userRow).toContainText("Administrator");
  await userRow
    .getByRole("button", { name: `Actions for ${email}`, exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Disable", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect(userRow).toContainText("Disabled");
  await userRow
    .getByRole("button", { name: `Actions for ${email}`, exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Enable", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect(userRow).not.toContainText("Disabled");
  await userRow
    .getByRole("button", { name: `Actions for ${email}`, exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Reset password", exact: true })
    .click();
  const reset = page.getByRole("dialog", {
    name: "Reset password",
    exact: true,
  });
  await reset.getByLabel("New password", { exact: true }).fill(password);
  await reset
    .getByRole("button", { name: "Reset password", exact: true })
    .click();
  await expect(reset).toBeHidden();
});
