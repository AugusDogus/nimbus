import { connection } from "next/server";
import { preflight } from "@/server/mcp/oauth/http";
import { authorizationServerMetadata, metadataResponse, protectedResourceMetadata } from "@/server/mcp/oauth/metadata";
import { withMcp } from "@/server/mcp/runtime";

/** OAuth discovery documents. `connection()` keeps them out of build-time prerendering. */
export const Discovery = {
  authorizationServer: async () => {
    await connection();
    return withMcp("discovery", async (oauth) => metadataResponse(authorizationServerMetadata(oauth.origin)));
  },
  protectedResource: async () => {
    await connection();
    return withMcp("discovery", async (oauth) => metadataResponse(protectedResourceMetadata(oauth.origin)));
  },
  preflight: () => preflight("GET"),
} as const;
