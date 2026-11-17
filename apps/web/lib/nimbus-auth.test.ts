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

describe("rate limits", () => {
  test("a rate-limited sign-in is audited and says when to retry with Retry-After", async () => {
    await t.createUser("first@example.test");
    const attempt = () =>
      t.request("POST", "/sign-in/email", {
        body: { email: "first@example.test", password: "wrong password" },
        ip: "203.0.113.7",
      });
    let response = await attempt();
    for (let tries = 0; tries < 20 && response.status !== 429; tries++)
      response = await attempt();
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    const events = await t.auditEvents();
    expect(
      events.find((event) => event.action === "auth.rate_limited"),
    ).toMatchObject({
      ip: "203.0.113.7",
      details: { service: "auth", path: "/sign-in/email" },
    });
  });
});

describe("audit labels", () => {
  test("a failed sign-in records the address only when it is an email address", async () => {
    await t.createUser("first@example.test");
    for (const email of ["MySecretPassw0rd!", "nobody@example.test"])
      await t.request("POST", "/sign-in/email", {
        body: { email, password: "wrong password" },
      });
    const failures = (await t.auditEvents()).filter(
      (event) => event.action === "auth.sign_in_failed",
    );
    expect(failures.map((event) => event.actor)).toEqual([
      { type: "anonymous" },
      { type: "anonymous", label: "nobody@example.test" },
    ]);
  });
});

describe("account endpoints", () => {
  test("endpoints Nimbus does not use, which need session tokens or move provider tokens, are off", async () => {
    const admin = await t.createUser("first@example.test");
    for (const endpoint of [
      "/link-social",
      "/unlink-account",
      "/revoke-session",
      "/admin/revoke-user-session",
      "/get-access-token",
      "/refresh-token",
    ]) {
      const response = await t.request("POST", endpoint, {
        cookie: admin.cookie,
        body: {},
      });
      expect({ endpoint, status: response.status }).toEqual({
        endpoint,
        status: 404,
      });
    }
  });

  test("a role change through update-user is audited as a role change", async () => {
    const admin = await t.createUser("first@example.test");
    const member = await t.createUser("member@example.test", {
      as: admin.cookie,
    });
    const response = await t.request("POST", "/admin/update-user", {
      cookie: admin.cookie,
      body: { userId: member.id, data: { role: "admin" } },
    });
    expect(response.status).toBe(200);
    const events = await t.auditEvents();
    expect(
      events.find(
        (event) =>
          event.action === "account.role_changed" &&
          event.target?.id === member.id,
      ),
    ).toMatchObject({
      actor: { type: "user", id: admin.id },
      target: { label: "member@example.test" },
      details: { role: "admin" },
    });
  });
});

describe("password guessing across many addresses", () => {
  const guess = (email: string, ip: string, password = "wrong password") =>
    t.request("POST", "/sign-in/email", { body: { email, password }, ip });

  test("slows guesses at one account from many addresses, without locking out its known addresses", async () => {
    const owner = await t.createUser("owner@example.test");
    await t.signIn("owner@example.test", "198.18.1.200");
    let refused: Response | null = null;
    for (let index = 0; index < 30 && !refused; index++) {
      const response = await guess("owner@example.test", `198.18.0.${index}`);
      if (response.status === 429) refused = response;
      else expect(response.status).toBe(401);
    }
    expect(refused).not.toBeNull();
    expect(Number(refused?.headers.get("retry-after"))).toBeGreaterThan(0);
    // The right password from a new address waits too, so a correct guess is not revealed.
    expect(
      (await guess("owner@example.test", "198.18.0.250", t.password)).status,
    ).toBe(429);
    // An address the account signed in from before still works.
    expect(
      (await guess("owner@example.test", "198.18.1.200", t.password)).status,
    ).toBe(200);
    // Other accounts are not affected.
    await t.createUser("other@example.test", { as: owner.cookie });
    expect(
      (await guess("other@example.test", "198.18.0.251", t.password)).status,
    ).toBe(200);
  });
});
