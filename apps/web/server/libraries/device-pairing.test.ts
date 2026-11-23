import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { devicePairings, pairedDevices } from "../db/library-schema";
import { mcpGrants, mcpTokens } from "../db/mcp-schema";
import { listConnections } from "../mcp/oauth/connections";
import { authenticateBearer, handleRevoke } from "../mcp/oauth/tokens";
import { hashToken } from "../mcp/oauth/secrets";
import {
  DevicePairing,
  MAX_PENDING_PAIRINGS,
  PAIRING_TTL_MS,
  type PairStart,
} from "./device-pairing";
import { Libraries } from "./libraries";
import {
  openLibraryTest,
  testOrigin,
  type LibraryTest,
} from "./library-testing";
import { PairedDevices } from "./paired-devices";
import { PairingCode } from "./pairing-code";

const address = "192.0.2.10";
const DAY = 24 * 60 * 60 * 1000;
let t: LibraryTest;
let libraryId: string;

beforeEach(async () => {
  t = await openLibraryTest();
  await mkdir(t.drive.absolute("library/kitchen"), { recursive: true });
  const created = await Libraries.create(
    t.ctx,
    await t.drive.access("owner"),
    false,
    { title: "Kitchen library", folders: ["library/kitchen"] },
  );
  if (!created.ok) throw new Error(created.error.message);
  libraryId = created.value.id;
});
afterEach(() => t.close());

function start(name = "Media box", from = address): PairStart {
  const started = DevicePairing.start(t.ctx, name, from);
  if (!started.ok) throw new Error(started.error.message);
  return started.value;
}

const poll = (deviceCode: string) =>
  DevicePairing.poll(t.ctx, deviceCode, address);

async function review(pairingCode: string) {
  const reviewed = await DevicePairing.review(
    t.ctx,
    t.signIn("owner"),
    pairingCode,
    address,
  );
  if (!reviewed.ok) throw new Error(reviewed.error.message);
  return reviewed.value;
}

async function approve(pairingCode: string) {
  const shown = await review(pairingCode);
  return DevicePairing.decide(
    t.ctx,
    t.signIn("owner"),
    {
      pairingId: shown.pairingId,
      ticket: shown.ticket,
      decision: { kind: "approve", libraryId },
    },
    address,
  );
}

describe("start", () => {
  test("issues a secret device code, a 4+4 user code and the configured verification address", () => {
    const started = start();
    expect(started.deviceCode).toStartWith("nimbus_pairing_");
    // 32 random bytes in base64url after the prefix: 256 bits.
    expect(started.deviceCode.length - "nimbus_pairing_".length).toBe(43);
    expect(started.pairingCode).toMatch(
      /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/,
    );
    expect(started.verificationUrl).toBe(`${testOrigin}/pair`);
    expect(started.verificationUrlComplete).toBe(
      `${testOrigin}/pair?code=${started.pairingCode}`,
    );
    expect(started.expiresIn).toBe(600);
    expect(started.interval).toBe(5);
    // Only hashes are stored.
    const [row] = t.drive.db.select().from(devicePairings).all();
    expect(row?.deviceCodeHash).toBe(hashToken(started.deviceCode));
    expect(JSON.stringify(row)).not.toContain(started.deviceCode);
    expect(JSON.stringify(row)).not.toContain(
      started.pairingCode.replace("-", ""),
    );
  });

  test("is unavailable without a configured public address", () => {
    const started = DevicePairing.start(
      { ...t.ctx, origin: { kind: "unavailable", reason: "No address." } },
      "Media box",
      address,
    );
    expect(started).toEqual({
      ok: false,
      error: { code: "service_unavailable", message: "No address." },
    });
  });

  test("allows 5 starts per address in 10 minutes", () => {
    for (let index = 0; index < 5; index++) start();
    const refused = DevicePairing.start(t.ctx, "Media box", address);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("rate_limited");
      expect(refused.error.retryAfterSeconds).toBeGreaterThan(0);
    }
    expect(start("Kitchen tablet", "192.0.2.99").pairingCode).toBeString();
  });

  test("starts one address is refused do not use up everyone's allowance", () => {
    for (let index = 0; index < 5; index++) start("Media box", "192.0.2.66");
    for (let index = 0; index < 150; index++)
      expect(DevicePairing.start(t.ctx, "Media box", "192.0.2.66").ok).toBe(
        false,
      );
    expect(start("Kitchen tablet", "198.51.100.7").pairingCode).toBeString();
  });

  test("caps pending requests for the whole server in SQLite", () => {
    for (let index = 0; index < MAX_PENDING_PAIRINGS; index++)
      t.drive.db
        .insert(devicePairings)
        .values({
          id: `pair_${index}`,
          deviceCodeHash: `device-${index}`,
          pairingCodeHash: `code-${index}`,
          deviceName: "Media box",
          state: "pending",
          createdAt: t.now(),
          expiresAt: t.now() + PAIRING_TTL_MS,
          intervalSeconds: 5,
        })
        .run();
    const refused = DevicePairing.start(t.ctx, "Media box", address);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("rate_limited");
    // Expired requests do not count and are cleaned up.
    t.advance(PAIRING_TTL_MS + 1);
    expect(start().pairingCode).toBeString();
    expect(t.drive.db.select().from(devicePairings).all()).toHaveLength(1);
  });

  test("refuses device names with control characters or over 80 characters", () => {
    expect(DevicePairing.parseDeviceName("  Media box  ")).toEqual({
      ok: true,
      value: "Media box",
    });
    for (const name of [
      "",
      "   ",
      "Box\u0000",
      "a\u202eb",
      "Media\u200f box",
      "Media\u2069box",
      "Media\u200bbox",
      "Line\u2028break",
      "Media box\n",
      "\ufeffMedia box",
      " Media box\t",
      "x".repeat(81),
      42,
    ])
      expect(DevicePairing.parseDeviceName(name).ok).toBe(false);
  });
});

describe("poll", () => {
  test("is pending until approved, then returns the token exactly once", async () => {
    const started = start();
    expect(poll(started.deviceCode)).toEqual({
      ok: true,
      value: { status: "pending" },
    });
    expect((await approve(started.pairingCode)).ok).toBe(true);
    t.advance(5000);
    const approved = poll(started.deviceCode);
    expect(approved.ok && approved.value.status).toBe("approved");
    if (!approved.ok || approved.value.status !== "approved")
      throw new Error("not approved");
    expect(approved.value.token).toStartWith("nimbus_device_");
    expect(approved.value.library).toEqual({
      id: libraryId,
      title: "Kitchen library",
    });
    // A device grant with one device token, its parent the device code, in the grant store.
    const [token] = t.drive.db.select().from(mcpTokens).all();
    expect(token?.hash).toBe(hashToken(approved.value.token));
    expect(token?.kind).toBe("device_token");
    expect(token?.parentHash).toBe(hashToken(started.deviceCode));
    const [grant] = t.drive.db.select().from(mcpGrants).all();
    expect(grant?.resource).toBe("device");
    expect(grant?.userId).toBe("owner");
    const [device] = t.drive.db.select().from(pairedDevices).all();
    expect(device?.deviceName).toBe("Media box");
    expect(device?.libraryId).toBe(libraryId);
    // Not an MCP connection.
    expect(await listConnections(t.drive.db, "owner")).toEqual([]);
    // Reuse of a redeemed code is refused without saying so.
    t.advance(5000);
    expect(poll(started.deviceCode)).toEqual({
      ok: true,
      value: { status: "expired" },
    });
    expect(t.drive.db.select().from(pairedDevices).all()).toHaveLength(1);
  });

  test("an unapproved code grants nothing and expires after 10 minutes", async () => {
    const started = start();
    t.advance(PAIRING_TTL_MS);
    expect(poll(started.deviceCode)).toEqual({
      ok: true,
      value: { status: "expired" },
    });
    expect(
      (
        await DevicePairing.review(
          t.ctx,
          t.signIn("owner"),
          started.pairingCode,
          address,
        )
      ).ok,
    ).toBe(false);
    expect(t.drive.db.select().from(pairedDevices).all()).toHaveLength(0);
  });

  test("an approval not collected in time expires and pairs nothing", async () => {
    const started = start();
    expect((await approve(started.pairingCode)).ok).toBe(true);
    t.advance(PAIRING_TTL_MS);
    expect(poll(started.deviceCode).ok && poll(started.deviceCode)).toEqual({
      ok: true,
      value: { status: "expired" },
    });
    expect(t.drive.db.select().from(pairedDevices).all()).toHaveLength(0);
  });

  test("a denied code stays denied and pairs nothing", async () => {
    const started = start();
    const shown = await review(started.pairingCode);
    const denied = await DevicePairing.decide(
      t.ctx,
      t.signIn("owner"),
      {
        pairingId: shown.pairingId,
        ticket: shown.ticket,
        decision: { kind: "deny" },
      },
      address,
    );
    expect(denied).toEqual({ ok: true, value: { deviceName: "Media box" } });
    expect(poll(started.deviceCode)).toEqual({
      ok: true,
      value: { status: "denied" },
    });
    expect(t.drive.db.select().from(pairedDevices).all()).toHaveLength(0);
  });

  test("unknown codes look expired", () => {
    expect(poll("nimbus_pairing_unknown")).toEqual({
      ok: true,
      value: { status: "expired" },
    });
    expect(poll("something-else")).toEqual({
      ok: true,
      value: { status: "expired" },
    });
  });

  test("an early poll is told to slow down, and every early poll adds 5 seconds, persisted", () => {
    const started = start();
    expect(poll(started.deviceCode).ok).toBe(true);
    t.advance(1000);
    const first = poll(started.deviceCode);
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error).toMatchObject({
      code: "slow_down",
      retryAfterSeconds: 10,
      interval: 10,
    });
    expect(first.error.message).toContain("10 seconds");
    // The new interval holds: 6 seconds is still too early.
    t.advance(6000);
    const second = poll(started.deviceCode);
    expect(!second.ok && second.error.interval).toBe(15);
    const [row] = t.drive.db
      .select({ interval: devicePairings.intervalSeconds })
      .from(devicePairings)
      .all();
    expect(row?.interval).toBe(15);
    t.advance(15_000);
    expect(poll(started.deviceCode)).toEqual({
      ok: true,
      value: { status: "pending" },
    });
  });
});

describe("activation", () => {
  test("shows the request, the owner's libraries and what is granted", async () => {
    const started = start("Kitchen tablet");
    t.advance(30_000);
    const shown = await review(started.pairingCode.toLowerCase());
    expect(shown).toMatchObject({
      deviceName: "Kitchen tablet",
      pairingCode: started.pairingCode,
      requestedAt: t.now() - 30_000,
      account: { email: "owner@example.test" },
      libraries: [
        {
          id: libraryId,
          title: "Kitchen library",
          folders: ["library/kitchen"],
          devices: [],
        },
      ],
    });
  });

  test("is refused while impersonating", async () => {
    const started = start();
    const reviewed = await DevicePairing.review(
      t.ctx,
      t.signIn("alice", "owner"),
      started.pairingCode,
      address,
    );
    expect(reviewed.ok).toBe(false);
    if (!reviewed.ok) expect(reviewed.error.kind).toBe("forbidden");
  });

  test("a decision needs this session's ticket for this request", async () => {
    const started = start();
    const shown = await review(started.pairingCode);
    const other = start("Hall display");
    const otherShown = await review(other.pairingCode);
    for (const attempt of [
      {
        session: t.signIn("alice"),
        ticket: shown.ticket,
        pairingId: shown.pairingId,
      },
      {
        session: t.signIn("owner"),
        ticket: otherShown.ticket,
        pairingId: shown.pairingId,
      },
      {
        session: t.signIn("owner"),
        ticket: `${shown.ticket}x`,
        pairingId: shown.pairingId,
      },
    ]) {
      const decided = await DevicePairing.decide(
        t.ctx,
        attempt.session,
        {
          pairingId: attempt.pairingId,
          ticket: attempt.ticket,
          decision: { kind: "deny" },
        },
        address,
      );
      expect(decided.ok).toBe(false);
    }
    expect(poll(started.deviceCode)).toEqual({
      ok: true,
      value: { status: "pending" },
    });
  });

  test("a double submission or a second decision changes nothing", async () => {
    const started = start();
    const shown = await review(started.pairingCode);
    const decide = (kind: "approve" | "deny") =>
      DevicePairing.decide(
        t.ctx,
        t.signIn("owner"),
        {
          pairingId: shown.pairingId,
          ticket: shown.ticket,
          decision: kind === "approve" ? { kind, libraryId } : { kind },
        },
        address,
      );
    const [first, second] = await Promise.all([
      decide("approve"),
      decide("approve"),
    ]);
    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    expect((await decide("deny")).ok).toBe(false);
    const [row] = t.drive.db.select().from(devicePairings).all();
    expect(row?.state).toBe("approved");
  });

  test("approval needs one of the account's own libraries", async () => {
    await mkdir(t.drive.absolute("library/alice-maps"), { recursive: true });
    await t.drive.grant("library/alice-maps", "alice", "admin");
    const alices = await Libraries.create(
      t.ctx,
      await t.drive.access("alice"),
      false,
      { title: "Maps", folders: ["library/alice-maps"] },
    );
    if (!alices.ok) throw new Error(alices.error.message);
    const started = start();
    const shown = await review(started.pairingCode);
    const decided = await DevicePairing.decide(
      t.ctx,
      t.signIn("owner"),
      {
        pairingId: shown.pairingId,
        ticket: shown.ticket,
        decision: { kind: "approve", libraryId: alices.value.id },
      },
      address,
    );
    expect(decided.ok).toBe(false);
  });

  test("lookups are limited to 5 per account in 10 minutes", async () => {
    const started = start();
    for (let index = 0; index < 5; index++) await review(started.pairingCode);
    const refused = await DevicePairing.review(
      t.ctx,
      t.signIn("owner"),
      started.pairingCode,
      "192.0.2.77",
    );
    expect(!refused.ok && refused.error.kind).toBe("rate_limited");
  });
});

describe("paired devices", () => {
  let paired = 0;
  async function pair(name = "Media box") {
    const started = start(name, `198.51.100.${++paired}`);
    if (!(await approve(started.pairingCode)).ok)
      throw new Error("not approved");
    const approved = poll(started.deviceCode);
    if (!approved.ok || approved.value.status !== "approved")
      throw new Error("not approved");
    return approved.value.token;
  }
  const bearer = (token: string) =>
    new Request(`${testOrigin}/api/library/v1/me`, {
      headers: { authorization: `Bearer ${token}` },
    });

  const use = (token: string) => {
    const auth = PairedDevices.authenticate(t.ctx, bearer(token));
    if (auth.ok) PairedDevices.touch(t.ctx, auth.device);
    return auth;
  };

  test("stay signed in while used, and lapse after 30 days unused", async () => {
    const token = await pair();
    t.advance(29 * DAY);
    expect(use(token).ok).toBe(true);
    t.advance(29 * DAY);
    expect(use(token).ok).toBe(true);
    t.advance(30 * DAY);
    const lapsed = use(token);
    expect(!lapsed.ok && lapsed.error.code).toBe("token_revoked");
    const [row] = t.drive.db.select().from(pairedDevices).all();
    expect(row?.revokedReason).toBe("idle_lapsed");
    // Lapsed stays lapsed.
    t.advance(-29 * DAY);
    expect(use(token).ok).toBe(false);
  });

  test("only authorized use slides the idle deadline", async () => {
    const token = await pair();
    t.advance(29 * DAY);
    // Authenticated but never authorized, as a refused or rate-limited request is.
    expect(PairedDevices.authenticate(t.ctx, bearer(token)).ok).toBe(true);
    t.advance(2 * DAY);
    expect(use(token).ok).toBe(false);
  });

  test("device and MCP credentials are refused by each other's checks", async () => {
    const token = await pair();
    const mcp = await authenticateBearer(t.ctx, bearer(token));
    expect(mcp.kind).toBe("rejected");
    const refused = PairedDevices.authenticate(
      t.ctx,
      new Request(`${testOrigin}/api/library/v1/me`, {
        headers: { authorization: "Bearer nimbus_mcp_access_abc" },
      }),
    );
    expect(!refused.ok && refused.error.code).toBe("token_invalid");
    // The OAuth revocation endpoint leaves device tokens alone.
    await handleRevoke(
      { ...t.ctx, origin: testOrigin, secret: t.ctx.secret },
      new Request(`${testOrigin}/oauth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
      }),
    );
    expect(use(token).ok).toBe(true);
  });

  test("account security actions revoke every device of the account", async () => {
    const first = await pair("Media box");
    const second = await pair("Kitchen tablet");
    expect(
      await PairedDevices.revokeForUser(t.ctx, "owner", "password_changed"),
    ).toBe(2);
    for (const token of [first, second]) {
      const refused = PairedDevices.authenticate(t.ctx, bearer(token));
      expect(!refused.ok && refused.error.code).toBe("token_revoked");
    }
  });

  test("a disabled owner's device is refused at once", async () => {
    const token = await pair();
    // Another administrator first: Nimbus never disables its last one.
    t.drive.sqlite.run("UPDATE user SET role = 'admin' WHERE id = 'bob'");
    t.drive.sqlite.run("UPDATE user SET banned = 1 WHERE id = 'owner'");
    const refused = PairedDevices.authenticate(t.ctx, bearer(token));
    expect(!refused.ok && refused.error.code).toBe("token_revoked");
  });

  test("a missing, malformed or unknown token is told apart from a revoked one", async () => {
    const missing = PairedDevices.authenticate(
      t.ctx,
      new Request(`${testOrigin}/api/library/v1/me`),
    );
    expect(!missing.ok && missing.error.code).toBe("authorization_required");
    for (const header of ["Bearer nimbus_tv_unknown", "Basic abc", "Bearer"]) {
      const refused = PairedDevices.authenticate(
        t.ctx,
        new Request(`${testOrigin}/api/library/v1/me`, {
          headers: { authorization: header },
        }),
      );
      expect(!refused.ok && refused.error.code).toBe("token_invalid");
    }
    const token = await pair();
    const [device] = t.drive.db.select().from(pairedDevices).all();
    if (!device) throw new Error("no device");
    expect(
      PairedDevices.revoke(
        t.ctx,
        { id: "alice", email: "alice@example.test" },
        device.grantId,
      ),
    ).toBe(false);
    expect(
      PairedDevices.revoke(
        t.ctx,
        { id: "owner", email: "owner@example.test" },
        device.grantId,
      ),
    ).toBe(true);
    const revoked = PairedDevices.authenticate(t.ctx, bearer(token));
    expect(!revoked.ok && revoked.error.code).toBe("token_revoked");
    expect(
      t.drive.db
        .select({ reason: pairedDevices.revokedReason })
        .from(pairedDevices)
        .where(eq(pairedDevices.grantId, device.grantId))
        .all(),
    ).toEqual([{ reason: "settings" }]);
  });

  test("user codes parse as typed on the phone", () => {
    expect(PairingCode.parse(start().pairingCode.toLowerCase())).not.toBeNull();
  });
});

describe("waiting for the device", () => {
  test("an approval not yet collected is listed and can be cancelled, and then grants nothing", async () => {
    const started = start();
    expect((await approve(started.pairingCode)).ok).toBe(true);
    const [waiting] = DevicePairing.waiting(t.ctx, "owner");
    expect(waiting).toMatchObject({
      deviceName: "Media box",
      library: { id: libraryId, title: "Kitchen library" },
    });
    if (!waiting) throw new Error("not listed");
    const alice = { id: "alice", email: "alice@example.test" };
    const owner = { id: "owner", email: "owner@example.test" };
    expect(DevicePairing.cancel(t.ctx, alice, waiting.id)).toBe(false);
    expect(DevicePairing.cancel(t.ctx, owner, waiting.id)).toBe(true);
    expect(DevicePairing.waiting(t.ctx, "owner")).toEqual([]);
    t.advance(5000);
    expect(poll(started.deviceCode)).toEqual({
      ok: true,
      value: { status: "denied" },
    });
    expect(t.drive.db.select().from(pairedDevices).all()).toHaveLength(0);
  });

  test("account security actions cancel it too", async () => {
    const started = start();
    expect((await approve(started.pairingCode)).ok).toBe(true);
    await PairedDevices.revokeForUser(t.ctx, "owner", "signed_out_everywhere");
    expect(DevicePairing.waiting(t.ctx, "owner")).toEqual([]);
    t.advance(5000);
    expect(poll(started.deviceCode)).toEqual({
      ok: true,
      value: { status: "denied" },
    });
  });
});
