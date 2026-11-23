import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { libraries, pairedDevices } from "../server/db/library-schema";
import { mcpGrants } from "../server/db/mcp-schema";
import { PairedDevices } from "../server/libraries/paired-devices";
import { createTestAuth, testOrigin, type TestAuth } from "./auth-testing";

let t: TestAuth;
beforeEach(async () => {
  t = await createTestAuth({});
});
afterEach(async () => {
  await t.close();
});

/** A member with one paired device, and the administrator who manages them. */
async function memberWithDevice() {
  const admin = await t.createUser("admin@example.test");
  const member = await t.createUser("member@example.test", {
    as: admin.cookie,
  });
  const now = Date.now();
  const device = t.db.transaction((tx) => {
    tx.insert(libraries)
      .values({
        id: "lib_kitchen00001",
        ownerId: member.id,
        title: "Kitchen",
        createdAt: now,
        updatedAt: now,
        catalogChangedAt: now,
      })
      .run();
    return PairedDevices.create(tx, {
      ownerId: member.id,
      libraryId: "lib_kitchen00001",
      deviceName: "Media box",
      parentHash: "pairing-hash",
      now,
    });
  });
  return { admin, member, device };
}

const signIn = (token: string) =>
  PairedDevices.authenticate(
    { db: t.db, now: Date.now },
    new Request(`${testOrigin}/api/library/v1/me`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );

const revoked = async (grantId: string) => {
  const [grant] = await t.db
    .select({ revokedAt: mcpGrants.revokedAt })
    .from(mcpGrants)
    .where(eq(mcpGrants.id, grantId));
  const [binding] = await t.db
    .select({ reason: pairedDevices.revokedReason })
    .from(pairedDevices)
    .where(eq(pairedDevices.grantId, grantId));
  return { revoked: grant?.revokedAt !== null, reason: binding?.reason };
};

test.each([
  ["/admin/ban-user", (userId: string) => ({ userId })],
  [
    "/admin/update-user",
    (userId: string) => ({ userId, data: { banned: true } }),
  ],
])(
  "disabling an account through %s disconnects its devices for good",
  async (path, body) => {
    const { admin, member, device } = await memberWithDevice();
    expect(signIn(device.token).ok).toBe(true);
    const response = await t.request("POST", path, {
      cookie: admin.cookie,
      body: body(member.id),
    });
    expect(response.status).toBe(200);
    expect(await revoked(device.grantId)).toEqual({
      revoked: true,
      reason: "account_disabled",
    });
    // Enabling the account again revives nothing.
    await t.request("POST", "/admin/unban-user", {
      cookie: admin.cookie,
      body: { userId: member.id },
    });
    const refused = signIn(device.token);
    expect(!refused.ok && refused.error.code).toBe("token_revoked");
  },
);
