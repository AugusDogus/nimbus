import { expect } from "@playwright/test";
import { client, navigate, test } from "./helpers";

test("My files opens the account's own home folder, which cannot be moved or deleted", async ({
  page,
  context,
  isMobile,
}) => {
  await page.goto("/");
  await navigate(page, "My files", isMobile);
  await expect(page).toHaveURL("/browse/homes/admin");
  const rpc = await client(context);
  expect((await rpc.access.me.query()).home).toBe("homes/admin");
  await expect(
    rpc.files.rename.mutate({ path: "homes/admin", newName: "elsewhere" }),
  ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });
  await expect(
    rpc.files.delete.mutate({ path: "homes" }),
  ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });
});
