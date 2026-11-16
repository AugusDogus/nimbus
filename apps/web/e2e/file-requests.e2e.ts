import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { z } from "zod";
import { action, client, test } from "./helpers";
import { FileListing } from "@nimbus/api/file-listing";

test("file requests accept anonymous uploads into one folder without exposing it", async ({
  page,
  context,
  browser,
  isMobile,
}, testInfo) => {
  const folder = `inbox-${randomUUID()}`;
  const rpc = await client(context);
  await rpc.files.createFolder.mutate({ name: folder });
  await rpc.files.createFolder.mutate({ path: folder, name: "private" });

  await page.goto("/");
  await action(page, folder, "Share", isMobile);
  const sharing = page.getByRole("dialog", {
    name: `Share ${folder}`,
    exact: true,
  });
  await sharing
    .getByRole("button", { name: "Request files", exact: true })
    .click();
  const requestDialog = page.getByRole("dialog", {
    name: `Request files for ${folder}`,
  });
  await requestDialog
    .getByLabel("Note for uploaders (optional)")
    .fill("Send your signed forms here.");
  await requestDialog
    .getByLabel("Password (optional)")
    .fill("upload-password-42");
  await requestDialog.getByLabel("Number of files").fill("2");
  await requestDialog
    .getByRole("button", { name: "Create upload link", exact: true })
    .click();
  const link = await requestDialog
    .getByRole("textbox", { name: "Upload link", exact: true })
    .inputValue();
  const token = new URL(link).pathname.split("/").pop() ?? "";
  await requestDialog
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await expect(requestDialog).toBeHidden();

  const anonymous = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: page.viewportSize(),
  });
  try {
    const visitor = await anonymous.newPage();
    await visitor.goto(link);
    await expect(
      visitor.getByRole("heading", { name: "Protected upload link" }),
    ).toBeVisible();
    await visitor
      .getByLabel("Password", { exact: true })
      .fill("upload-password-42");
    await visitor.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(
      visitor.getByRole("heading", { name: `Upload files to ${folder}` }),
    ).toBeVisible();
    await expect(
      visitor.getByText("Send your signed forms here."),
    ).toBeVisible();
    await expect(visitor.getByText("private")).toHaveCount(0);
    const files = visitor.getByLabel("Files to upload");
    await files.setInputFiles({
      name: "form.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("first form"),
    });
    await expect(visitor.getByRole("img", { name: "Uploaded" })).toHaveCount(1);
    await files.setInputFiles({
      name: "form.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("second form"),
    });
    await expect(visitor.getByRole("img", { name: "Uploaded" })).toHaveCount(2);
    await files.setInputFiles({
      name: "extra.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("too many"),
    });
    await expect(
      visitor
        .getByRole("alert")
        .filter({ hasText: "received all the files it accepts" }),
    ).toBeVisible();
    await visitor.screenshot({
      path: testInfo.outputPath("file-request.png"),
      fullPage: true,
    });

    // Uploaders hold no read access: no listing in details, no download route.
    const details = await anonymous.request.get(`/api/file-request/${token}`);
    expect(
      Object.keys(
        z.record(z.string(), z.unknown()).parse(await details.json()),
      ).sort(),
    ).toEqual([
      "expiresAt",
      "folder",
      "maxFileBytes",
      "note",
      "remainingFiles",
    ]);
    expect((await anonymous.request.get(`/api/share/${token}`)).status()).toBe(
      404,
    );
    // Without the unlock cookie nothing can be created.
    const outsider = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const create = await outsider.request.post("/api/file-request/upload", {
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Length": "4",
        "Upload-Metadata": `filename ${Buffer.from("x.txt").toString("base64")},request ${Buffer.from(token).toString("base64")}`,
      },
    });
    expect(create.status()).toBe(401);
    await outsider.close();

    const received = FileListing.entries(
      await rpc.files.list.query({ path: folder }),
    )
      .map((entry) => entry.name)
      .sort();
    expect(received).toEqual(["form (1).txt", "form.txt", "private"]);

    await page.goto("/shared?tab=requests");
    const record = page
      .getByRole("listitem")
      .filter({ has: page.locator(`a[href="/r/${token}"]`) });
    await expect(record).toContainText("2 of 2 files");
    await record.getByRole("button", { name: "Revoke", exact: true }).click();
    await page
      .getByRole("alertdialog", { name: "Revoke this upload link?" })
      .getByRole("button", { name: "Revoke link" })
      .click();
    await expect(record).toHaveCount(0);
    await visitor.reload();
    await expect(
      visitor.getByRole("heading", { name: "Upload link unavailable" }),
    ).toBeVisible();
  } finally {
    await anonymous.close();
  }
});

test("file request links follow their folder through moves, trash and restore", async ({
  context,
  browser,
}) => {
  const folder = `moving-${randomUUID()}`;
  const parent = `parent-${randomUUID()}`;
  const rpc = await client(context);
  await rpc.files.createFolder.mutate({ name: folder });
  await rpc.files.createFolder.mutate({ name: parent });
  const { token } = await rpc.fileRequests.create.mutate({
    path: folder,
    note: "",
    expiresAt: null,
    maxFileBytes: null,
    maxFiles: null,
    maxTotalBytes: null,
  });
  const anonymous = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  try {
    const details = () => anonymous.request.get(`/api/file-request/${token}`);
    await rpc.files.move.mutate({
      sourcePath: folder,
      destinationPath: parent,
    });
    expect(await (await details()).json()).toMatchObject({ folder });
    expect(
      (await rpc.fileRequests.list.query()).find(
        (request) => request.token === token,
      )?.path,
    ).toBe(`${parent}/${folder}`);
    await rpc.files.delete.mutate({ path: parent });
    expect((await details()).status()).toBe(404);
    const trashed = (await rpc.trash.list.query()).find(
      (item) => item.path === parent,
    );
    if (!trashed) throw new Error(`Expected ${parent} in trash.`);
    await rpc.trash.restore.mutate({ id: trashed.id });
    expect(await (await details()).json()).toMatchObject({ folder });
  } finally {
    await anonymous.close();
  }
});
