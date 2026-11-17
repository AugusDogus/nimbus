import { expect, test } from "bun:test";
import { appRouter } from "./routers";
import { createTestDriveStore } from "./testing";

const callerFor = (session: unknown) =>
  appRouter.createCaller({
    headers: new Headers(),
    drive: createTestDriveStore().store,
    session,
    sessionStillValid: async () => true,
    preferences: {
      getUserPreferences: async () => null,
      setUserPreferences: async (_userId, prefs) => prefs,
    },
  });

test("an administrator signed in as someone else cannot create app passwords for them", async () => {
  const impersonated = callerFor({
    user: { id: "reader" },
    session: { impersonatedBy: "user-1" },
  });
  await expect(
    impersonated.appPasswords.create({ name: "Laptop" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(await impersonated.appPasswords.list()).toEqual([]);
  const own = callerFor({
    user: { id: "reader" },
    session: { impersonatedBy: null },
  });
  const created = await own.appPasswords.create({ name: "Laptop" });
  expect(created.token.length).toBeGreaterThan(20);
});
