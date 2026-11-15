import { redirect } from "next/navigation";
import { getSession } from "@/server/files-data";
import { mcpResource, readMcpConfig } from "@/server/mcp/config";
import { listConnections } from "@/server/mcp/oauth/connections";
import { db } from "@/server/db";
import { McpSettings } from "./mcp-settings";

export default async function McpPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const config = readMcpConfig();
  return (
    <McpSettings
      state={
        config.kind === "enabled"
          ? { kind: "enabled", serverUrl: mcpResource(config.origin), connections: await listConnections(db, session.user.id) }
          : { kind: "unavailable" }
      }
    />
  );
}
