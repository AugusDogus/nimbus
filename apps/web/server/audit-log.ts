import { and, desc, eq, gte, lt, lte, sql, type SQL } from "drizzle-orm";
import {
  auditActions,
  type AuditAction,
  type RecordedAuditEvent,
} from "@nimbus/api/audit";
import type { Database } from "./db";
import { auditEvents } from "./db/schema";

/** Days that audit events are kept. The database refuses to delete anything younger than 30 days. */
export const AuditRetention = {
  minimumDays: 30,
  parse(value: string | undefined): number {
    if (value === undefined || value === "") return 365;
    const days = Number(value);
    if (
      !/^\d+$/.test(value) ||
      days < AuditRetention.minimumDays ||
      days > 36_500
    )
      throw new Error(
        `NIMBUS_AUDIT_RETENTION_DAYS is "${value}". Use a whole number of days from ${AuditRetention.minimumDays} to 36500, or leave it unset to keep a year.`,
      );
    return days;
  },
} as const;

const clip = (value: string | undefined, length: number) =>
  value === undefined ? null : value.slice(0, length);

/** Batch writer installed with `setAuditSink` at server startup. */
export const createAuditSink =
  (db: Database) => async (events: RecordedAuditEvent[]) => {
    await db.insert(auditEvents).values(
      events.map((event) => ({
        at: event.at,
        action: event.action,
        actorType: event.actor.type,
        actorId: event.actor.type === "user" ? event.actor.id : null,
        actorLabel:
          event.actor.type === "system" ? null : clip(event.actor.label, 320),
        targetType: event.target?.type ?? null,
        targetId: clip(event.target?.id, 1024),
        targetLabel: clip(event.target?.label, 1024),
        ip: clip(event.ip, 64),
        userAgent: clip(event.userAgent, 512),
        details: event.details ?? null,
      })),
    );
  };

/**
 * Deletes events older than the retention period in small batches. Local SQLite calls
 * block the event loop, so each batch is short, the loop yields between batches, and
 * one run stops after a time budget; the hourly cleanup continues where it stopped.
 */
export async function purgeAuditEvents(
  db: Database,
  retentionDays: number,
  now = Date.now(),
  budgetMs = 2_000,
) {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const started = performance.now();
  let removed = 0;
  while (performance.now() - started < budgetMs) {
    const deleted = db
      .delete(auditEvents)
      .where(
        sql`${auditEvents.id} IN (SELECT ${auditEvents.id} FROM ${auditEvents} WHERE ${auditEvents.at} < ${cutoff} ORDER BY ${auditEvents.id} LIMIT 200)`,
      )
      .returning({ id: auditEvents.id })
      .all().length;
    removed += deleted;
    if (deleted < 200) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return removed;
}

export type AuditQuery = {
  action?: AuditAction;
  actorId?: string;
  from?: number;
  to?: number;
  before?: number;
  limit: number;
};

export const AuditQuery = {
  /** Parses viewer filters from URL search parameters. Unknown values are ignored. */
  fromSearchParams(
    params: Record<string, string | string[] | undefined>,
  ): AuditQuery {
    const one = (key: string) => {
      const value = params[key];
      return Array.isArray(value) ? value[0] : value;
    };
    const action = auditActions.find((entry) => entry === one("action"));
    const date = (key: string, endOfDay: boolean) => {
      const value = one(key);
      if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
      const time = Date.parse(
        `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`,
      );
      return Number.isNaN(time) ? undefined : time;
    };
    const before = Number(one("before"));
    const actorId = one("actor");
    return {
      ...(action && { action }),
      ...(actorId && { actorId: actorId.slice(0, 200) }),
      ...(date("from", false) !== undefined && { from: date("from", false) }),
      ...(date("to", true) !== undefined && { to: date("to", true) }),
      ...(Number.isSafeInteger(before) && before > 0 && { before }),
      limit: 50,
    };
  },
} as const;

/** Newest first, keyset-paginated by ID. Returns one extra row to signal another page. */
export async function listAuditEvents(db: Database, query: AuditQuery) {
  const filters: SQL[] = [];
  if (query.action) filters.push(eq(auditEvents.action, query.action));
  if (query.actorId) filters.push(eq(auditEvents.actorId, query.actorId));
  if (query.from !== undefined) filters.push(gte(auditEvents.at, query.from));
  if (query.to !== undefined) filters.push(lte(auditEvents.at, query.to));
  if (query.before !== undefined)
    filters.push(lt(auditEvents.id, query.before));
  const rows = await db
    .select()
    .from(auditEvents)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(auditEvents.id))
    .limit(query.limit + 1);
  return {
    events: rows.slice(0, query.limit),
    next: rows.length > query.limit ? rows[query.limit - 1]?.id : undefined,
  };
}
