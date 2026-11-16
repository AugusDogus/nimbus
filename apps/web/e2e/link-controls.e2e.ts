import { expect } from "@playwright/test";
import { client, test } from "./helpers";

test("public links enforce download limits and preview-only mode, and can be edited", async ({
  page,
  context,
  browser,
}) => {
  const rpc = await client(context);
  const anonymous = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  try {
    const limited = await rpc.shares.create.mutate({
      path: "alpha.txt",
      expiresAt: null,
      maxDownloads: 2,
    });
    const limitedURL = `/api/share/${limited.token}`;
    // Metadata, HEAD requests and resumed ranges do not use up downloads.
    expect((await anonymous.request.get(limitedURL)).status()).toBe(200);
    expect(
      (await anonymous.request.head(`${limitedURL}?download=1`)).status(),
    ).toBe(200);
    expect(
      (
        await anonymous.request.get(`${limitedURL}?download=1`, {
          headers: { Range: "bytes=1-" },
        })
      ).status(),
    ).toBe(206);
    expect(
      (await anonymous.request.get(`${limitedURL}?download=1`)).status(),
    ).toBe(200);
    expect(
      (await anonymous.request.get(`${limitedURL}?preview=1`)).status(),
    ).toBe(200);
    const exhausted = await anonymous.request.get(`${limitedURL}?download=1`);
    expect(exhausted.status()).toBe(404);
    expect(await exhausted.text()).toContain("download limit");

    const viewOnly = await rpc.shares.create.mutate({
      path: "docs",
      expiresAt: null,
      mode: "view",
    });
    const viewURL = `/api/share/${viewOnly.token}`;
    expect(
      (await anonymous.request.get(`${viewURL}?download=1`)).status(),
    ).toBe(403);
    expect(
      (
        await anonymous.request.get(`${viewURL}?path=readme.md&download=1`)
      ).status(),
    ).toBe(403);
    const preview = await anonymous.request.get(
      `${viewURL}?path=readme.md&preview=1`,
    );
    expect(preview.status()).toBe(200);
    expect(preview.headers()["content-disposition"]?.startsWith("inline")).toBe(
      true,
    );
    const visitor = await anonymous.newPage();
    await visitor.goto(`/s/${viewOnly.token}`);
    await expect(
      visitor.getByText("Preview only", { exact: true }),
    ).toBeVisible();
    await expect(visitor.getByRole("link", { name: /^Download/ })).toHaveCount(
      0,
    );

    await page.goto("/shared?tab=links");
    const record = page
      .getByRole("listitem")
      .filter({ has: page.locator(`a[href="/s/${limited.token}"]`) });
    await expect(record).toContainText("2 of 2 downloads");
    await record.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Edit link to alpha.txt" });
    await editor.getByLabel("Download limit (optional)").fill("");
    await editor.getByLabel("Password (optional)").fill("edited-password-42");
    await editor.getByRole("checkbox", { name: "Preview only" }).check();
    await editor
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(editor).toBeHidden();
    await expect(record).toContainText("Password required");
    await expect(record).toContainText("2 downloads · Preview only");
    // Raising the limit reopens the link, now behind its new password.
    expect(
      (await anonymous.request.get(`${limitedURL}?preview=1`)).status(),
    ).toBe(401);
    const unlocked = await anonymous.request.post(limitedURL, {
      data: { password: "edited-password-42" },
    });
    expect(unlocked.status()).toBe(200);
    expect(
      (await anonymous.request.get(`${limitedURL}?preview=1`)).status(),
    ).toBe(200);
    expect(
      (await anonymous.request.get(`${limitedURL}?download=1`)).status(),
    ).toBe(403);
  } finally {
    await anonymous.close();
  }
});
