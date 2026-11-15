import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Append-only security audit trail. Rows are never updated; triggers in the migration
 * reject updates and reject deleting rows younger than the 30-day minimum retention.
 * Actor and target labels are snapshots, so entries stay readable after accounts are removed.
 */
export const auditEvents = sqliteTable(
  "nimbus_audit_event",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: integer("at").notNull(),
    action: text("action").notNull(),
    actorType: text("actor_type", { enum: ["user", "anonymous", "system"] }).notNull(),
    actorId: text("actor_id"),
    actorLabel: text("actor_label"),
    targetType: text("target_type"),
    targetId: text("target_id"),
    targetLabel: text("target_label"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    details: text("details", { mode: "json" }).$type<Record<string, string | number | boolean | null>>(),
  },
  (table) => [
    index("nimbus_audit_event_at_idx").on(table.at),
    index("nimbus_audit_event_action_idx").on(table.action, table.id),
    index("nimbus_audit_event_actor_idx").on(table.actorId, table.id),
  ],
);
