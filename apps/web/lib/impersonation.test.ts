import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { recordAudit, runWithAuditRequest } from "@nimbus/api/audit";
import { createTestAuth, testOrigin, type TestAuth } from "./auth-testing";

let t: TestAuth;
beforeEach(async () => {
  t = await createTestAuth();
});
afterEach(async () => {
  await t.close();
});

const sessionShape = z.object({
  session: z.object({
    impersonatedBy: z.string().nullish(),
    expiresAt: z.coerce.date(),
  }),
  user: z.object({ id: z.string(), email: z.string() }),
});

const currentSession = async (cookie: string) => {
  const response = await t.request("GET", "/get-session", { cookie });
  return sessionShape.nullable().parse(await response.json());
};

/** An administrator, a member, and the administrator signed in as the member. */
async function impersonating() {
  const admin = await t.createUser("admin@example.test");
  const member = await t.createUser("member@example.test", {
    as: admin.cookie,
  });
  const response = await t.request("POST", "/admin/impersonate-user", {
    cookie: admin.cookie,
    body: { userId: member.id },
  });
  expect(response.status).toBe(200);
  return { admin, member, cookie: t.cookieFrom(response) };
}

describe("signing in as another account", () => {
  test("an administrator signs in as a member for at most an hour, and the start is audited", async () => {
    const { admin, member, cookie } = await impersonating();
    const session = await currentSession(cookie);
    expect(session?.user.id).toBe(member.id);
    expect(session?.session.impersonatedBy).toBe(admin.id);
    expect(
      (session?.session.expiresAt.getTime() ?? 0) - Date.now(),
    ).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(
      (await t.auditEvents()).find(
        (event) => event.action === "account.impersonation_started",
      ),
    ).toMatchObject({
      actor: { type: "user", id: admin.id, label: "admin@example.test" },
      target: { type: "user", id: member.id, label: "member@example.test" },
      ip: t.address,
    });
  });

  test("an administrator cannot sign in as another administrator or as themselves", async () => {
    const admin = await t.createUser("admin@example.test");
    const other = await t.createUser("other@example.test", {
      as: admin.cookie,
    });
    await t.request("POST", "/admin/set-role", {
      cookie: admin.cookie,
      body: { userId: other.id, role: "admin" },
    });
    for (const userId of [other.id, admin.id]) {
      const response = await t.request("POST", "/admin/impersonate-user", {
        cookie: admin.cookie,
        body: { userId },
      });
      expect(response.status).toBe(403);
    }
  });

  test("an impersonated session cannot change the account's security or reach administration", async () => {
    const { member, cookie } = await impersonating();
    const refused = [
      [
        "POST",
        "/change-password",
        { currentPassword: t.password, newPassword: "a new password here" },
      ],
      ["POST", "/change-email", { newEmail: "new@example.test" }],
      ["POST", "/two-factor/enable", { password: t.password }],
      ["GET", "/passkey/generate-register-options", undefined],
      ["POST", "/revoke-sessions", {}],
      ["POST", "/revoke-other-sessions", {}],
      ["POST", "/nimbus/revoke-session", { id: "any" }],
      ["POST", "/delete-user", {}],
      ["GET", "/admin/list-users", undefined],
      ["POST", "/admin/impersonate-user", { userId: member.id }],
    ] as const;
    for (const [method, endpoint, body] of refused) {
      const response = await t.request(method, endpoint, {
        cookie,
        ...(body !== undefined && { body }),
      });
      expect({ endpoint, status: response.status }).toEqual({
        endpoint,
        status: 403,
      });
    }
    expect((await currentSession(cookie))?.user.id).toBe(member.id);
  });

  test("events recorded in an impersonated session name the administrator", async () => {
    const { admin, member, cookie } = await impersonating();
    await runWithAuditRequest({ ip: "192.0.2.9" }, async () => {
      // As a Nimbus route does: read the session, then act and audit as its user.
      await t.auth.api.getSession({
        headers: new Headers({ cookie, origin: testOrigin }),
      });
      recordAudit({
        action: "trash.moved",
        actor: { type: "user", id: member.id, label: "member@example.test" },
      });
    });
    expect(
      (await t.auditEvents()).find((event) => event.action === "trash.moved"),
    ).toMatchObject({
      details: {
        impersonatedBy: "admin@example.test",
        impersonatedById: admin.id,
      },
    });
  });

  test("stopping returns to the administrator's own session and is audited", async () => {
    const { admin, member, cookie } = await impersonating();
    const response = await t.request("POST", "/admin/stop-impersonating", {
      cookie,
      body: {},
    });
    expect(response.status).toBe(200);
    expect((await currentSession(t.cookieFrom(response)))?.user.id).toBe(
      admin.id,
    );
    expect(await currentSession(cookie)).toBeNull();
    expect(
      (await t.auditEvents()).find(
        (event) => event.action === "account.impersonation_stopped",
      ),
    ).toMatchObject({
      actor: { type: "user", id: admin.id },
      target: { type: "user", id: member.id, label: "member@example.test" },
    });
  });

  test("disabling the account or resetting its sign-in methods ends the impersonation", async () => {
    for (const end of [
      "/admin/ban-user",
      "/nimbus/admin/reset-second-factors",
    ]) {
      await t.close();
      t = await createTestAuth();
      const { admin, member, cookie } = await impersonating();
      const response = await t.request("POST", end, {
        cookie: admin.cookie,
        body: { userId: member.id },
      });
      expect(response.status).toBe(200);
      expect(await currentSession(cookie)).toBeNull();
    }
  });
});
