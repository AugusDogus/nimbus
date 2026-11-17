import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { z } from "zod";
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
  test("only one of several simultaneous first sign-ups creates an account", async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        t.request("POST", "/sign-up/email", {
          body: {
            email: `person${index}@example.test`,
            password: t.password,
            name: `Person ${index}`,
          },
          ip: `192.0.2.${index + 1}`,
        }),
      ),
    );
    expect(
      responses.filter((response) => response.status === 200),
    ).toHaveLength(1);
    expect(await t.db.select({ id: user.id }).from(user)).toHaveLength(1);
  });

  test("closed registration answers the same for existing and unknown addresses", async () => {
    await t.createUser("first@example.test");
    const attempt = async (email: string) => {
      const response = await t.request("POST", "/sign-up/email", {
        body: { email, password: t.password, name: "Someone" },
      });
      return { status: response.status, body: await response.text() };
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

describe("session tokens", () => {
  /** Every session token stored in the database. */
  const storedTokens = () =>
    t.sqlite
      .query("SELECT token FROM session")
      .values()
      .map(([token]) => String(token));

  test("responses never give a session token to page scripts", async () => {
    const signUp = await t.request("POST", "/sign-up/email", {
      body: {
        email: "first@example.test",
        password: t.password,
        name: "First",
      },
    });
    const admin = t.cookieFrom(signUp);
    const signIn = await t.request("POST", "/sign-in/email", {
      body: { email: "first@example.test", password: t.password },
    });
    const signInBody = await signIn.text();
    const userId = z
      .object({ user: z.object({ id: z.string() }) })
      .parse(JSON.parse(signInBody)).user.id;
    const bodies = [
      await signUp.text(),
      signInBody,
      await (await t.request("GET", "/get-session", { cookie: admin })).text(),
      await (
        await t.request("GET", "/list-sessions", { cookie: admin })
      ).text(),
      await (
        await t.request("POST", "/admin/list-user-sessions", {
          cookie: admin,
          body: { userId },
        })
      ).text(),
    ];
    const tokens = storedTokens();
    expect(tokens.length).toBeGreaterThan(1);
    for (const body of bodies) {
      expect(body).toContain(userId);
      for (const token of tokens) expect(body).not.toContain(token);
    }
    // The cookie still signs the browser in.
    const session = await t.request("GET", "/get-session", {
      cookie: t.cookieFrom(signIn),
    });
    expect(await session.json()).toMatchObject({
      user: { email: "first@example.test" },
    });
  });
});
