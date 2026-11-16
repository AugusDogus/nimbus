import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "node:url";
import * as schema from "./db/schema";
import {
  AuditQuery,
  AuditRetention,
  createAuditSink,
  listAuditEvents,
  purgeAuditEvents,
} from "./audit-log";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const day = 24 * 60 * 60 * 1000;
let client: Client;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  client = createClient({ url: "file::memory:" });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
});
afterEach(() => client.close());

const actor = { type: "user", id: "u1", label: "owner@example.test" } as const;

describe("audit storage", () => {
  it("rejects edits and deletion of recent events, and purges only expired ones", async () => {
    const now = Date.now();
    await createAuditSink(db)([
      { action: "share.created", actor, at: now - 400 * day },
      { action: "share.revoked", actor, at: now - 40 * day },
      { action: "grant.added", actor, at: now },
    ]);
    await expect(
      client.execute("UPDATE nimbus_audit_event SET action = 'x'"),
    ).rejects.toThrow("append-only");
    await expect(
      client.execute("DELETE FROM nimbus_audit_event"),
    ).rejects.toThrow("at least 30 days");
    await expect(
      client.execute(
        "INSERT OR REPLACE INTO nimbus_audit_event (id, at, action, actor_type) VALUES (1, 0, 'x', 'system')",
      ),
    ).rejects.toThrow("append-only");
    expect(await purgeAuditEvents(db, 365, now)).toBe(1);
    expect(await purgeAuditEvents(db, 30, now)).toBe(1);
    const remaining = await listAuditEvents(db, { limit: 50 });
    expect(remaining.events.map((event) => event.action)).toEqual([
      "grant.added",
    ]);
  });

  it("filters by action, actor and date and pages newest first", async () => {
    const at = Date.parse("2026-11-10T12:00:00Z");
    await createAuditSink(db)(
      Array.from({ length: 60 }, (_, index) => ({
        action: index % 2 ? "share.created" : "grant.added",
        actor:
          index < 50
            ? actor
            : { type: "user", id: "u2", label: "other@example.test" },
        at: at + index,
        ip: "198.51.100.1",
        details: { index },
      })),
    );
    const first = await listAuditEvents(
      db,
      AuditQuery.fromSearchParams({ action: "share.created", actor: "u1" }),
    );
    expect(first.events).toHaveLength(25);
    expect(first.events[0]?.details).toEqual({ index: 49 });
    expect(first.next).toBeUndefined();
    const page = await listAuditEvents(db, AuditQuery.fromSearchParams({}));
    expect(page.events).toHaveLength(50);
    const rest = await listAuditEvents(
      db,
      AuditQuery.fromSearchParams({ before: String(page.next) }),
    );
    expect(rest.events).toHaveLength(10);
    const outside = await listAuditEvents(
      db,
      AuditQuery.fromSearchParams({ from: "2026-11-11", to: "2026-11-12" }),
    );
    expect(outside.events).toHaveLength(0);
  });

  it("ignores unknown filter values instead of failing", () => {
    expect(
      AuditQuery.fromSearchParams({
        action: "drop table",
        before: "-1",
        from: "yesterday",
      }),
    ).toEqual({ limit: 50 });
  });

  it("validates retention", () => {
    expect(AuditRetention.parse(undefined)).toBe(365);
    expect(() => AuditRetention.parse("7")).toThrow(
      'NIMBUS_AUDIT_RETENTION_DAYS is "7"',
    );
  });
});

it("keeps the administrator triggers on the extended user table", async () => {
  await client.execute(
    "INSERT INTO user (id, name, email, role, email_verified) VALUES ('a', 'A', 'a@example.test', 'admin', 0)",
  );
  await expect(
    client.execute("UPDATE user SET role = 'user' WHERE id = 'a'"),
  ).rejects.toThrow("Nimbus requires an active administrator");
  await expect(
    client.execute("UPDATE user SET two_factor_enabled = 1 WHERE id = 'a'"),
  ).resolves.toBeDefined();
});
