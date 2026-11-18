import { recordAudit } from "@nimbus/api/audit";
import { McpScope } from "@nimbus/api/mcp-scope";
import { accountActor, clientTarget } from "./audit";
import { and, desc, eq, isNull } from "drizzle-orm";
import { user } from "../../db/auth-schema";
import { mcpClients, mcpGrants } from "../../db/mcp-schema";
import type { Database } from "./context";
import { revokeGrant } from "./tokens";

/** An approved MCP client as Settings lists it. */
export type McpConnection = {
  id: string;
  clientName: string;
  scopes: McpScope[];
  connectedAt: number;
  lastUsedAt: number | null;
};

export async function listConnections(
  db: Database,
  userId: string,
): Promise<McpConnection[]> {
  const rows = await db
    .select({
      id: mcpGrants.id,
      clientName: mcpClients.clientName,
      scope: mcpGrants.scope,
      connectedAt: mcpGrants.createdAt,
      lastUsedAt: mcpGrants.lastUsedAt,
    })
    .from(mcpGrants)
    .innerJoin(mcpClients, eq(mcpClients.clientId, mcpGrants.clientId))
    .where(and(eq(mcpGrants.userId, userId), isNull(mcpGrants.revokedAt)))
    .orderBy(desc(mcpGrants.createdAt));
  return rows.map(({ scope, ...row }) => ({
    ...row,
    scopes: McpScope.parse(scope).scopes,
  }));
}

/** Revoke one of `userId`'s own connections. False when it does not exist or belongs to someone else. */
export async function revokeConnection(
  db: Database,
  userId: string,
  grantId: string,
  now: number,
) {
  const [grant] = await db
    .select({ id: mcpGrants.id, clientId: mcpGrants.clientId })
    .from(mcpGrants)
    .where(
      and(
        eq(mcpGrants.id, grantId),
        eq(mcpGrants.userId, userId),
        isNull(mcpGrants.revokedAt),
      ),
    )
    .limit(1);
  if (!grant) return false;
  await revokeGrant(db, grantId, now);
  recordAudit({
    action: "mcp.client_disconnected",
    actor: await accountActor(db, userId),
    target: await clientTarget(db, grant.clientId),
    details: { by: "settings" },
  });
  return true;
}

/**
 * Disconnect every MCP client of `userId`, as account recovery, password changes and
 * signing out everywhere do. Their tokens stop working because each use checks the grant.
 * Returns how many clients were connected.
 */
export async function revokeUserConnections(
  db: Database,
  userId: string,
  now: number,
  by: string,
) {
  const revoked = await db
    .update(mcpGrants)
    .set({ revokedAt: now })
    .where(and(eq(mcpGrants.userId, userId), isNull(mcpGrants.revokedAt)))
    .returning({ clientId: mcpGrants.clientId });
  if (revoked.length === 0) return 0;
  const actor = await accountActor(db, userId);
  for (const grant of revoked)
    recordAudit({
      action: "mcp.client_disconnected",
      actor,
      target: await clientTarget(db, grant.clientId),
      details: { by },
    });
  return revoked.length;
}

/**
 * The account behind a connection that is still approved, whose account is enabled and whose
 * approval includes `scope`, or null. Links the tools hand out check it on every use.
 */
export async function liveConnectionUser(
  db: Database,
  grantId: string,
  scope: McpScope,
) {
  const [row] = await db
    .select({
      userId: mcpGrants.userId,
      scope: mcpGrants.scope,
      revokedAt: mcpGrants.revokedAt,
      banned: user.banned,
    })
    .from(mcpGrants)
    .innerJoin(user, eq(user.id, mcpGrants.userId))
    .where(eq(mcpGrants.id, grantId))
    .limit(1);
  return row &&
    row.revokedAt === null &&
    !row.banned &&
    McpScope.parse(row.scope).scopes.includes(scope)
    ? row.userId
    : null;
}
