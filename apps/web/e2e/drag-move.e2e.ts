import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { client, test, upload } from "./helpers";
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
    await target.dispatchEvent("drop", { dataTransfer: uploadDrop });
    await uploadDrop.dispose();
    await expect(
      page.getByRole("button", { name: "Dropped notes.txt", exact: true }),
    ).toBeVisible();
    expect(
      FileListing.entries(await rpc.files.list.query({ path: root })).map(
        (entry) => entry.name,
      ),
    ).toContain("Dropped notes.txt");
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
