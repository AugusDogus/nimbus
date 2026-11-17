import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { user } from "../server/db/schema";
import { createTestAuth, type TestAuth } from "./auth-testing";

let t: TestAuth;
beforeEach(async () => {
  t = await createTestAuth();
});
afterEach(async () => {
  await t.close();
});

const roleOf = async (id: string) =>
  (await t.db.select({ role: user.role }).from(user).where(eq(user.id, id)))[0]
    ?.role;

describe("first administrator", () => {
  test("the first account becomes the administrator and later accounts are members", async () => {
    const first = await t.createUser("first@example.test");
    const second = await t.createUser("second@example.test", {
      as: first.cookie,
    });
    expect(await roleOf(first.id)).toBe("admin");
    expect(await roleOf(second.id)).toBe("user");
  });
});

describe("last administrator", () => {
  test("the only administrator cannot be demoted, disabled or removed", async () => {
    const first = await t.createUser("first@example.test");
    for (const [endpoint, body] of [
      ["/admin/set-role", { userId: first.id, role: "user" }],
      ["/admin/ban-user", { userId: first.id }],
      ["/admin/remove-user", { userId: first.id }],
      ["/admin/update-user", { userId: first.id, data: { role: "user" } }],
    ] as const) {
      const response = await t.request("POST", endpoint, {
        cookie: first.cookie,
        body,
      });
      expect(response.status).toBe(403);
    }
    expect(await roleOf(first.id)).toBe("admin");
  });

  test("an administrator can be demoted once another administrator exists", async () => {
    const first = await t.createUser("first@example.test");
    const second = await t.createUser("second@example.test", {
      as: first.cookie,
    });
    await t.request("POST", "/admin/set-role", {
      cookie: first.cookie,
      body: { userId: second.id, role: "admin" },
    });
    const response = await t.request("POST", "/admin/set-role", {
      cookie: first.cookie,
      body: { userId: first.id, role: "user" },
    });
    expect(response.status).toBe(200);
    expect(await roleOf(first.id)).toBe("user");
  });
});

describe("registration", () => {
  test("closed registration answers the same for existing and unknown addresses", async () => {
    await t.createUser("first@example.test");
    const attempt = async (email: string) => {
      const response = await t.request("POST", "/sign-up/email", {
        body: { email, password: t.password, name: "Someone" },
      });
      return { status: response.status, body: await response.json() };
    };
    const existing = await attempt("first@example.test");
    const unknown = await attempt("nobody@example.test");
    expect(existing.status).toBe(403);
    expect(existing).toEqual(unknown);
  });

  test("sign-up is closed once an account exists", async () => {
    await t.createUser("first@example.test");
    const response = await t.request("POST", "/sign-up/email", {
      body: {
        email: "stranger@example.test",
        password: t.password,
        name: "Stranger",
      },
    });
    expect(response.status).toBe(403);
  });
});
