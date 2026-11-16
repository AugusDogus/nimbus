import { auditUser, type AuditActor } from "@nimbus/api/audit";
import { eq } from "drizzle-orm";
import { user } from "../../db/auth-schema";
import { mcpClients } from "../../db/mcp-schema";
import type { Database } from "./context";

/**
 * Labels for MCP audit events. Lookups run only on approvals, disconnections
 * and refused token requests, never on MCP tool calls.
 */
export async function accountActor(
  db: Database,
  userId: string,
): Promise<AuditActor> {
  const [row] = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return auditUser({ id: userId, email: row?.email ?? userId });
}

export async function clientTarget(db: Database, clientId: string) {
  const [row] = await db
    .select({ name: mcpClients.clientName })
    .from(mcpClients)
    .where(eq(mcpClients.clientId, clientId))
    .limit(1);
  return {
    type: "mcp_client" as const,
    id: clientId,
    label: row?.name ?? clientId,
  };
}
