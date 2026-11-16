import { McpScope } from "@nimbus/api/mcp-scope";
import { OAUTH_CLIENT_AUTH_METHODS } from "../../db/mcp-schema";
import { mcpResource } from "../config";
import { corsHeaders } from "./http";

/** RFC 8414 authorization server metadata (also served as OpenID discovery for clients that probe it). */
export const authorizationServerMetadata = (origin: string) => ({
  issuer: origin,
  authorization_endpoint: `${origin}/oauth/authorize`,
  token_endpoint: `${origin}/oauth/token`,
  registration_endpoint: `${origin}/oauth/register`,
  revocation_endpoint: `${origin}/oauth/revoke`,
  scopes_supported: [...McpScope.all],
  response_types_supported: ["code"],
  response_modes_supported: ["query"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: [...OAUTH_CLIENT_AUTH_METHODS],
  revocation_endpoint_auth_methods_supported: [...OAUTH_CLIENT_AUTH_METHODS],
  code_challenge_methods_supported: ["S256"],
  authorization_response_iss_parameter_supported: true,
});

/** RFC 9728 protected resource metadata for the MCP endpoint. */
export const protectedResourceMetadata = (origin: string) => ({
  resource: mcpResource(origin),
  authorization_servers: [origin],
  scopes_supported: [...McpScope.all],
  bearer_methods_supported: ["header"],
  resource_name: "Nimbus",
});

export const metadataResponse = (body: unknown) =>
  Response.json(body, {
    headers: { ...corsHeaders, "Cache-Control": "public, max-age=300" },
  });
