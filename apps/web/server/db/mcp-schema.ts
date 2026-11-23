import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";

export const OAUTH_CLIENT_AUTH_METHODS = [
  "none",
  "client_secret_basic",
  "client_secret_post",
] as const;
export type OAuthClientAuthMethod = (typeof OAUTH_CLIENT_AUTH_METHODS)[number];

/** An MCP client from RFC 7591 dynamic registration. Registrations without a grant are pruned after a day. */
export const mcpClients = sqliteTable("nimbus_mcp_client", {
  clientId: text("client_id").primaryKey(),
  clientName: text("client_name").notNull(),
  redirectUrisJson: text("redirect_uris_json").notNull(),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method", {
    enum: OAUTH_CLIENT_AUTH_METHODS,
  }).notNull(),
  /** SHA-256 of the client secret for confidential clients. */
  clientSecretHash: text("client_secret_hash"),
  scope: text("scope").notNull(),
  clientUri: text("client_uri"),
  createdAt: integer("created_at").notNull(),
});

/**
 * What a grant authorizes: `mcp`, an MCP client's access to the account's files, or `device`, a
 * paired device's read-only access to one library (see library-schema.ts). Each resource has its
 * own token kinds, listings and checks.
 */
export const GRANT_RESOURCES = ["mcp", "device"] as const;
export type GrantResource = (typeof GRANT_RESOURCES)[number];

/** One user's approval of one client: what Settings lists and revokes. */
export const mcpGrants = sqliteTable(
  "nimbus_mcp_grant",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => mcpClients.clientId, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    resource: text("resource", { enum: GRANT_RESOURCES })
      .notNull()
      .default("mcp"),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    revokedAt: integer("revoked_at"),
  },
  (table) => [index("nimbus_mcp_grant_user").on(table.userId)],
);

export const MCP_TOKEN_KINDS = [
  "authorization_code",
  "refresh_token",
  "access_token",
  /**
   * A paired device's one token, of a `device` grant. `expiresAt` is its idle deadline, moved
   * forward by each authorized use; it is never refreshed or rotated.
   */
  "device_token",
] as const;
export type McpTokenKind = (typeof MCP_TOKEN_KINDS)[number];

/**
 * Codes and tokens of a grant, stored only as SHA-256 hashes of random
 * 256-bit secrets. Revoking the grant invalidates every row: each use checks it.
 */
export const mcpTokens = sqliteTable(
  "nimbus_mcp_token",
  {
    hash: text("hash").primaryKey(),
    kind: text("kind", { enum: MCP_TOKEN_KINDS }).notNull(),
    grantId: text("grant_id")
      .notNull()
      .references(() => mcpGrants.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    expiresAt: integer("expires_at").notNull(),
    /** Set when a code is redeemed or a refresh token rotated. */
    consumedAt: integer("consumed_at"),
    /** Authorization codes: the redirect URI and PKCE challenge they were issued for. */
    redirectUri: text("redirect_uri"),
    codeChallenge: text("code_challenge"),
    createdAt: integer("created_at").notNull(),
    /** Tokens issued by redeeming a code or rotating a refresh token: that credential's hash. */
    parentHash: text("parent_hash"),
    /** Access tokens: when one first authenticated a request. */
    usedAt: integer("used_at"),
  },
  (table) => [
    index("nimbus_mcp_token_grant").on(table.grantId),
    index("nimbus_mcp_token_expiry").on(table.expiresAt),
    index("nimbus_mcp_token_parent").on(table.parentHash),
  ],
);

/**
 * Paths each MCP upload link is writing or has written, by link and path. A link writes each
 * path once: an upload reserves its row when it is admitted and marks it committed when its
 * content is in place, so two servers running side by side during an update can neither run
 * nor commit the same path for one link. See UploadClaims.
 */
export const mcpUploadClaims = sqliteTable(
  "nimbus_mcp_upload_claim",
  {
    key: text("key").primaryKey(),
    /** When the link expires: after that it admits nothing. */
    expiresAt: integer("expires_at").notNull(),
    state: text("state", { enum: ["reserved", "committed"] })
      .notNull()
      .default("committed"),
  },
  (table) => [index("nimbus_mcp_upload_claim_expiry").on(table.expiresAt)],
);
