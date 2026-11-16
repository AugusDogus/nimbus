import { preflight } from "@/server/mcp/oauth/http";
import {
  authorizationServerMetadata,
  metadataResponse,
  protectedResourceMetadata,
} from "@/server/mcp/oauth/metadata";
import { withMcp } from "@/server/mcp/runtime";

/** OAuth discovery documents. */
export const Discovery = {
  authorizationServer: () =>
    withMcp("discovery", async (oauth) =>
      metadataResponse(authorizationServerMetadata(oauth.origin)),
    ),
  protectedResource: () =>
    withMcp("discovery", async (oauth) =>
      metadataResponse(protectedResourceMetadata(oauth.origin)),
    ),
  preflight: () => preflight("GET"),
} as const;
