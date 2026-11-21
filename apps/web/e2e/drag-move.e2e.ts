import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { asMember, client, test, upload } from "./helpers";
import { FileListing } from "@nimbus/api/file-listing";

for (const view of ["list", "grid"] as const) {
  test(`drags files and folders into folders in ${view} view without overwriting conflicts`, async ({
    page,
    context,
    isMobile,
  }, testInfo) => {
    test.skip(
      isMobile,
      "Touch users move items through the existing Move menu.",
    );
    const root = `drag-${randomUUID()}`;
    const destination = "Archive notes";
    const folder = "Project notes";
    const filename = "Move me %20.txt";
    const conflict = "Existing notes.txt";
    const rpc = await client(context);
    await rpc.prefs.set.mutate({
      view,
      sortField: "name",
      sortDirection: "asc",
      groupByType: true,
    });
    await rpc.files.createFolder.mutate({ name: root });
    await rpc.files.createFolder.mutate({ path: root, name: destination });
    await rpc.files.createFolder.mutate({ path: root, name: folder });
    await rpc.files.createFolder.mutate({
      path: `${root}/${folder}`,
      name: "Nested notes",
    });
    await page.goto(`/browse/${root}/${encodeURIComponent(destination)}`);
    await upload(page, conflict, "Keep the destination contents.");
    await page.goto(`/browse/${root}`);
    await upload(page, filename, "Moved file contents.");
    await upload(page, conflict, "Keep the source contents.");

    const target = page.getByRole("link", { name: destination, exact: true });
    const source = page.getByRole("button", { name: filename, exact: true });
    await source.dragTo(target);
    await expect(source).toHaveCount(0);
    await expect
      .poll(async () =>
        FileListing.entries(
          await rpc.files.list.query({ path: `${root}/${destination}` }),
        ).map((entry) => entry.name),
      )
      .toContain(filename);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).toHaveURL(`/browse/${root}`);

    const sourceFolder = page.getByRole("link", { name: folder, exact: true });
    await sourceFolder.hover();
    await page.mouse.down();
    await target.hover();
    await target.hover();
    await expect(target).toHaveAttribute("data-drop-target", "true");
    await page.screenshot({
      path: testInfo.outputPath(`drag-${view}.png`),
      animations: "disabled",
    });
    await page.mouse.up();
    await expect(sourceFolder).toHaveCount(0);
    expect(
      FileListing.entries(
        await rpc.files.list.query({
          path: `${root}/${destination}/${folder}`,
        }),
      ).map((entry) => entry.name),
    ).toContain("Nested notes");

    const sourceConflict = page.getByRole("button", {
      name: conflict,
      exact: true,
    });
    await sourceConflict.dragTo(target);
    // One report, which stays until closed and names the item; the reason is the server's.
    const failure = page
      .getByRole("alert")
      .filter({ hasText: `Nothing was moved. “${conflict}”` });
    await expect(failure).toHaveCount(1);
    await expect(page.getByRole("alert")).toHaveCount(1);
    await page.locator('[aria-label="Close toast"]').click();
    await expect(failure).toHaveCount(0);
    await expect(sourceConflict).toBeVisible();
    const sourceDownload = await context.request.get(
      `/api/files/download?path=${encodeURIComponent(`${root}/${conflict}`)}`,
    );
    const targetDownload = await context.request.get(
      `/api/files/download?path=${encodeURIComponent(`${root}/${destination}/${conflict}`)}`,
    );
    expect(await sourceDownload.text()).toBe("Keep the source contents.");
    expect(await targetDownload.text()).toBe("Keep the destination contents.");

    const uploadDrop = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File(["Uploaded from the desktop."], "Dropped notes.txt", {
          type: "text/plain",
        }),
      );
      return transfer;
    });
    // Files from the computer dropped on a folder go into that folder, as the hint says.
    await target.dispatchEvent("dragover", { dataTransfer: uploadDrop });
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: `Upload to “${destination}”` }),
    ).toBeVisible();
    await target.dispatchEvent("drop", { dataTransfer: uploadDrop });
    await uploadDrop.dispose();
    await expect
      .poll(async () =>
        FileListing.entries(
          await rpc.files.list.query({ path: `${root}/${destination}` }),
        ).map((entry) => entry.name),
      )
      .toContain("Dropped notes.txt");
    expect(
      FileListing.entries(await rpc.files.list.query({ path: root })).map(
        (entry) => entry.name,
      ),
    ).not.toContain("Dropped notes.txt");
  });
}

test("dragging follows the pointer, not the window width: a mouse drags in a narrow window, touch alone never", async ({
  page,
  context,
  isMobile,
}) => {
  const root = `pointer-${randomUUID()}`;
  const rpc = await client(context);
  await rpc.files.createFolder.mutate({ name: root });
  await rpc.files.createFolder.mutate({ path: root, name: "Into" });
  await rpc.files.createFolder.mutate({ path: root, name: "Moved" });
  // The phone project has a touch screen only, the desktop one a mouse.
  await page.setViewportSize({ width: isMobile ? 1024 : 600, height: 800 });
  await page.goto(`/browse/${root}`);
  const source = page.getByRole("link", { name: "Moved", exact: true });
  await expect(source).toBeVisible();
  if (isMobile) {
    await expect(source).not.toHaveAttribute("draggable", "true");
    return;
  }
  await expect(source).toHaveAttribute("draggable", "true");
  await source.dragTo(page.getByRole("link", { name: "Into", exact: true }));
  await expect(source).toHaveCount(0);
  expect(
    FileListing.entries(
      await rpc.files.list.query({ path: `${root}/Into` }),
    ).map((entry) => entry.name),
  ).toEqual(["Moved"]);
});

test("files from the computer dropped on a folder the account can only view are refused, not uploaded elsewhere", async ({
  browser,
  context,
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Phones have no files to drag in from a desktop.");
  const viewOnly = `view-only-${randomUUID()}`;
  const writable = `writable-${randomUUID()}`;
  const rpc = await client(context);
  await rpc.files.createFolder.mutate({ name: viewOnly });
  await rpc.files.createFolder.mutate({ name: writable });
  const { member, memberContext } = await asMember(
    browser,
    context,
    page,
    isMobile,
    [
      { path: viewOnly, permission: "read" },
      { path: writable, permission: "write" },
    ],
  );
  try {
    await member.goto("/");
    const drop = (name: string) =>
      member.evaluateHandle((file) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(["From the desktop."], file));
        return transfer;
      }, name);
    const refused = await drop("refused.txt");
    const viewOnlyRow = member.getByRole("link", {
      name: viewOnly,
      exact: true,
    });
    await viewOnlyRow.dispatchEvent("dragover", { dataTransfer: refused });
    await expect(viewOnlyRow).toHaveAttribute("data-drop-target", "refused");
    await expect(
      member
        .getByRole("status")
        .filter({ hasText: `You can only view “${viewOnly}”` }),
    ).toBeVisible();
    await viewOnlyRow.dispatchEvent("drop", { dataTransfer: refused });
    const taken = await drop("taken.txt");
    await member
      .getByRole("link", { name: writable, exact: true })
      .dispatchEvent("drop", { dataTransfer: taken });
    await expect
      .poll(async () =>
        FileListing.entries(await rpc.files.list.query({ path: writable })).map(
          (entry) => entry.name,
        ),
      )
      .toEqual(["taken.txt"]);
    expect(
      FileListing.entries(await rpc.files.list.query({ path: viewOnly })),
    ).toEqual([]);
  } finally {
    await memberContext.close();
  }
});

test("files from the computer dropped on a folder while a move is still running go into that folder", async ({
  page,
  context,
  isMobile,
}) => {
  test.skip(isMobile, "Phones do not drag.");
  const root = `while-moving-${randomUUID()}`;
  const rpc = await client(context);
  await rpc.files.createFolder.mutate({ name: root });
  for (const name of ["Moving", "Into", "Files go here"])
    await rpc.files.createFolder.mutate({ path: root, name });
  // Hold the move, as a slow server would, while the files are dropped.
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/files\.move/, async (route) => {
    await released;
    await route.continue();
  });
  await page.goto(`/browse/${root}`);
  const row = (name: string) => page.getByRole("link", { name, exact: true });
  await row("Moving").dragTo(row("Into"));
  await expect(row("Moving")).toHaveAttribute("aria-busy", "true");
  const files = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["Meanwhile."], "meanwhile.txt"));
    return transfer;
  });
  const target = row("Files go here");
  await target.dispatchEvent("dragover", { dataTransfer: files });
  await target.dispatchEvent("drop", { dataTransfer: files });
  release();
  const names = async (path: string) =>
    FileListing.entries(await rpc.files.list.query({ path })).map(
      (entry) => entry.name,
    );
  await expect
    .poll(() => names(`${root}/Files go here`))
    .toEqual(["meanwhile.txt"]);
  await expect.poll(() => names(`${root}/Into`)).toEqual(["Moving"]);
  expect(await names(root)).not.toContain("meanwhile.txt");
});
