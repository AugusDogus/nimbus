import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { groupMembers, groups, user } from "../server/db/schema";
import { createTestAuth, type TestAuth } from "./auth-testing";
import { startMockOidcProvider, type IdentityClaims } from "./oidc-testing";

const provider = startMockOidcProvider();
afterAll(() => provider.stop());

let t: TestAuth;
afterEach(async () => {
  await t.close();
});

const setUp = async (
  settings: { autoProvision?: boolean; groupsClaim?: string | null } = {},
) => {
  t = await createTestAuth({ oidc: provider.config(settings) });
};

/** Signs in through the provider: the browser starts at Nimbus, the provider redirects back. */
async function signInWithProvider(claims: IdentityClaims) {
  const start = await t.request("POST", "/sign-in/social", {
    body: { provider: "oidc", callbackURL: "/", errorCallbackURL: "/login" },
  });
  expect(start.status).toBe(200);
  const authorize = new URL(
    z.object({ url: z.string() }).parse(await start.json()).url,
  );
  provider.signInAs(claims, authorize.searchParams.get("nonce") ?? undefined);
  const state = z.string().parse(authorize.searchParams.get("state"));
  const callback = await t.request(
    "GET",
    `/callback/oidc?${new URLSearchParams({ code: "provider-code", state })}`,
    { cookie: t.cookieFrom(start) },
  );
  return {
    status: callback.status,
    location: callback.headers.get("location"),
    cookie: t.cookieFrom(callback),
  };
}

const identity = (email: string, verified = true): IdentityClaims => ({
  sub: `subject-${email}`,
  email,
  email_verified: verified,
  name: email,
});

/** Where a refused callback sends the browser, and the error code the sign-in page explains. */
const errorPage = (location: string | null) => {
  const url = new URL(location ?? "", "http://nimbus.invalid");
  return { path: url.pathname, error: url.searchParams.get("error") };
};

const accounts = () => t.db.select({ email: user.email }).from(user);

describe("single sign-on", () => {
  test("an existing account signs in through the provider and is audited", async () => {
    await setUp();
    const admin = await t.createUser("admin@example.test");
    const member = await t.createUser("member@example.test", {
      as: admin.cookie,
    });
    const result = await signInWithProvider(identity("member@example.test"));
    expect(result).toMatchObject({ status: 302, location: "/" });
    const session = await t.request("GET", "/get-session", {
      cookie: result.cookie,
    });
    expect(await session.json()).toMatchObject({
      user: { id: member.id },
    });
    expect(
      (await t.auditEvents()).find(
        (event) =>
          event.action === "auth.sign_in" && event.details?.method === "oidc",
      ),
    ).toMatchObject({ actor: { id: member.id } });
  });

  test("an unverified provider email is sent to the sign-in page with its error", async () => {
    await setUp({ autoProvision: true });
    await t.createUser("admin@example.test");
    const result = await signInWithProvider(
      identity("stranger@example.test", false),
    );
    expect(result.status).toBe(302);
    expect(errorPage(result.location)).toEqual({
      path: "/login",
      error: "email_not_verified",
    });
    expect(await accounts()).toHaveLength(1);
  });

  test("single sign-on before the administrator exists is sent to the sign-in page with its error", async () => {
    await setUp({ autoProvision: true });
    const result = await signInWithProvider(identity("first@example.test"));
    expect(result.status).toBe(302);
    expect(errorPage(result.location)).toEqual({
      path: "/login",
      error: "administrator_required",
    });
    expect(await accounts()).toHaveLength(0);
  });

  test("an ID token posted directly cannot sign in or create an account", async () => {
    await setUp({ autoProvision: true });
    const admin = await t.createUser("admin@example.test");
    await t.createUser("member@example.test", { as: admin.cookie });
    for (const claims of [
      identity("stranger@example.test", false),
      identity("member@example.test"),
    ]) {
      const response = await t.request("POST", "/sign-in/social", {
        body: {
          provider: "oidc",
          idToken: { token: provider.idToken(claims) },
        },
      });
      expect(response.status).toBe(400);
      expect(t.cookieFrom(response)).toBe("");
    }
    expect(await accounts()).toHaveLength(2);
  });

  test("the provider's groups replace the person's group memberships", async () => {
    await setUp({ groupsClaim: "groups" });
    const admin = await t.createUser("admin@example.test");
    const member = await t.createUser("member@example.test", {
      as: admin.cookie,
    });
    await t.db.insert(groups).values([
      { id: "engineering", name: "Engineering" },
      { id: "finance", name: "Finance" },
    ]);
    await t.db
      .insert(groupMembers)
      .values({ groupId: "finance", userId: member.id });
    const result = await signInWithProvider({
      ...identity("member@example.test"),
      groups: ["Engineering", "Unknown"],
    });
    expect(result.status).toBe(302);
    expect(
      await t.db
        .select({ groupId: groupMembers.groupId })
        .from(groupMembers)
        .where(eq(groupMembers.userId, member.id)),
    ).toEqual([{ groupId: "engineering" }]);
    expect(await t.db.select({ name: groups.name }).from(groups)).toHaveLength(
      2,
    );
  });
});
