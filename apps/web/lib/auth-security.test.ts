import { expect, test } from "bun:test";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin, twoFactor } from "better-auth/plugins";
import { createTestDriveStore } from "@nimbus/api/testing";
import { nimbusSecurity } from "./auth-security";

const appPassword = (id: string, userId: string) => ({
  id,
  userId,
  name: `Device ${id}`,
  tokenHash: `hash-${id}`,
  createdAt: 1,
});

test("resetting sign-in methods revokes the account's WebDAV app passwords", async () => {
  const memory = createTestDriveStore();
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: "test-secret-that-is-at-least-32-characters",
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      twoFactor: [],
      passkey: [],
    }),
    emailAndPassword: { enabled: true },
    plugins: [
      admin(),
      twoFactor(),
      passkey(),
      nimbusSecurity({
        appPasswords: memory.store,
        disconnectMcpClients: async () => 0,
      }),
    ],
  });
  const signUp = (email: string) =>
    auth.api.signUpEmail({
      body: { email, password: "correct horse battery", name: email },
      returnHeaders: true,
    });
  const administrator = await signUp("admin@example.test");
  const member = await signUp("member@example.test");
  await (
    await auth.$context
  ).internalAdapter.updateUser(administrator.response.user.id, {
    role: "admin",
  });
  const memberId = member.response.user.id;
  await memory.store.addAppPassword(appPassword("laptop", memberId));
  await memory.store.addAppPassword(appPassword("phone", memberId));
  await memory.store.addAppPassword(
    appPassword("other", administrator.response.user.id),
  );

  const cookie = administrator.headers.getSetCookie().join("; ");
  expect(
    await auth.api.resetSecondFactors({
      body: { userId: memberId },
      headers: new Headers({ cookie }),
    }),
  ).toEqual({ reset: true });

  // WebDAV authenticates a request by finding its app password's hash.
  expect(await memory.store.findAppPassword("hash-laptop")).toBeNull();
  expect(await memory.store.findAppPassword("hash-phone")).toBeNull();
  expect(await memory.store.listAppPasswords(memberId)).toEqual([]);
  expect(await memory.store.findAppPassword("hash-other")).not.toBeNull();
});
