import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { mcpClients, mcpGrants, mcpTokens } from "../server/db/mcp-schema";
import {
  ACCESS_TOKEN_TTL_MS,
  mintSecret,
  TokenPrefix,
} from "../server/mcp/oauth/secrets";
import { authenticateBearer } from "../server/mcp/oauth/tokens";
import type { MailMessage } from "../server/mail";
import { createTestAuth, testOrigin, type TestAuth } from "./auth-testing";

let t: TestAuth;
let sent: MailMessage[];
beforeEach(async () => {
  sent = [];
  t = await createTestAuth({
    sendMail: async (message) => {
      sent.push(message);
    },
  });
});
afterEach(async () => {
  await t.close();
});

/** Approves an MCP client for `userId` and returns its live access token. */
async function connectClient(userId: string) {
  const now = Date.now();
  const clientId = crypto.randomUUID();
  const grantId = crypto.randomUUID();
  await t.db.insert(mcpClients).values({
    clientId,
    clientName: "Claude Code",
    redirectUrisJson: JSON.stringify(["http://127.0.0.1:1/callback"]),
    tokenEndpointAuthMethod: "none",
    scope: "files:read",
    createdAt: now,
  });
  await t.db.insert(mcpGrants).values({
    id: grantId,
    userId,
    clientId,
    scope: "files:read",
    createdAt: now,
  });
  const access = mintSecret(TokenPrefix.accessToken);
  await t.db.insert(mcpTokens).values({
    hash: access.hash,
    kind: "access_token",
    grantId,
    scope: "files:read",
    expiresAt: now + ACCESS_TOKEN_TTL_MS,
    createdAt: now,
  });
  return { grantId, token: access.secret };
}

const bearer = (token: string) =>
  authenticateBearer(
    { db: t.db, now: Date.now },
    new Request(`${testOrigin}/api/mcp`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );

const revokedAt = async (grantId: string) =>
  (
    await t.db
      .select({ revokedAt: mcpGrants.revokedAt })
      .from(mcpGrants)
      .where(eq(mcpGrants.id, grantId))
  )[0]?.revokedAt ?? null;

async function accounts() {
  const admin = await t.createUser("admin@example.test");
  const member = await t.createUser("member@example.test", {
    as: admin.cookie,
  });
  const client = await connectClient(member.id);
  const untouched = await connectClient(admin.id);
  expect((await bearer(client.token)).kind).toBe("authenticated");
  return { admin, member, client, untouched };
}

async function expectDisconnected(
  client: { grantId: string; token: string },
  untouched: { grantId: string },
) {
  expect(await revokedAt(client.grantId)).not.toBeNull();
  expect(await bearer(client.token)).toMatchObject({ kind: "rejected" });
  expect(await revokedAt(untouched.grantId)).toBeNull();
  const events = await t.auditEvents();
  expect(
    events.filter((event) => event.action === "mcp.client_disconnected"),
  ).toHaveLength(1);
}

describe("account recovery disconnects MCP clients", () => {
  test("an administrator's reset of sign-in methods", async () => {
    const { admin, member, client, untouched } = await accounts();
    const response = await t.request(
      "POST",
      "/nimbus/admin/reset-second-factors",
      { cookie: admin.cookie, body: { userId: member.id } },
    );
    expect(response.status).toBe(200);
    await expectDisconnected(client, untouched);
  });

  test("an administrator's sign out everywhere", async () => {
    const { admin, member, client, untouched } = await accounts();
    const response = await t.request("POST", "/admin/revoke-user-sessions", {
      cookie: admin.cookie,
      body: { userId: member.id },
    });
    expect(response.status).toBe(200);
    await expectDisconnected(client, untouched);
  });

  test("an administrator setting a new password", async () => {
    const { admin, member, client, untouched } = await accounts();
    const response = await t.request("POST", "/admin/set-user-password", {
      cookie: admin.cookie,
      body: { userId: member.id, newPassword: "a brand new password" },
    });
    expect(response.status).toBe(200);
    await expectDisconnected(client, untouched);
  });

  test("the user signing out of every session", async () => {
    const { member, client, untouched } = await accounts();
    const response = await t.request("POST", "/revoke-sessions", {
      cookie: member.cookie,
      body: {},
    });
    expect(response.status).toBe(200);
    await expectDisconnected(client, untouched);
  });

  test("the user changing their password", async () => {
    const { member, client, untouched } = await accounts();
    const response = await t.request("POST", "/change-password", {
      cookie: member.cookie,
      body: {
        currentPassword: t.password,
        newPassword: "a brand new password",
        revokeOtherSessions: true,
      },
    });
    expect(response.status).toBe(200);
    await expectDisconnected(client, untouched);
  });

  test("the user resetting a forgotten password by email", async () => {
    const { client, untouched } = await accounts();
    const requested = await t.request("POST", "/request-password-reset", {
      body: {
        email: "member@example.test",
        redirectTo: "/reset-password",
      },
    });
    expect(requested.status).toBe(200);
    await Bun.sleep(10);
    const link = sent[0]?.text.match(/https?:\/\/\S+/)?.[0];
    const token = link && new URL(link).pathname.split("/").at(-1);
    expect(token).toBeString();
    const response = await t.request("POST", "/reset-password", {
      body: {
        token: z.string().parse(token),
        newPassword: "a brand new password",
      },
    });
    expect(response.status).toBe(200);
    await expectDisconnected(client, untouched);
  });

  test("signing out other browsers leaves MCP clients connected", async () => {
    const { member, client } = await accounts();
    const response = await t.request("POST", "/revoke-other-sessions", {
      cookie: member.cookie,
      body: {},
    });
    expect(response.status).toBe(200);
    expect(await revokedAt(client.grantId)).toBeNull();
  });
});
