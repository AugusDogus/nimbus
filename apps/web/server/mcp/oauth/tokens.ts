import { createHash } from "node:crypto";
import { McpScope } from "@nimbus/api/mcp-scope";
import { and, eq, isNull, lt } from "drizzle-orm";
import { mcpGrants, mcpTokens } from "../../db/mcp-schema";
import { user } from "../../db/auth-schema";
import { mcpResource } from "../config";
import { hit, throttleRules } from "../throttle";
import { authenticateClient, constantTimeEqual, presentsCredentials, throttled, type OAuthClient } from "./clients";
import type { Database, OAuthContext } from "./context";
import { clientAddress, corsHeaders, errorResponse, json, protocolError, readForm, type ProtocolError } from "./http";
import {
  ACCESS_TOKEN_TTL_MS,
  AUTHORIZATION_CODE_REPLAY_WINDOW_MS,
  hashToken,
  mintSecret,
  REFRESH_REUSE_GRACE_MS,
  REFRESH_TOKEN_TTL_MS,
  TokenPrefix,
} from "./secrets";

const invalidGrant = (description: string) => protocolError(400, "invalid_grant", description);
const invalidRequest = (description: string) => protocolError(400, "invalid_request", description);
const codeVerifier = /^[A-Za-z0-9\-._~]{43,128}$/;
const s256 = (verifier: string) => createHash("sha256").update(verifier, "ascii").digest("base64url");

type Issued = { accessToken: string; refreshToken: string; scope: string };
type Exchange = { ok: true; value: Issued } | { ok: false; error: ProtocolError };

/** A token row with its grant and account, the state every check needs. */
async function loadToken(db: Database, secret: string) {
  const [row] = await db
    .select({
      hash: mcpTokens.hash,
      kind: mcpTokens.kind,
      scope: mcpTokens.scope,
      expiresAt: mcpTokens.expiresAt,
      consumedAt: mcpTokens.consumedAt,
      redirectUri: mcpTokens.redirectUri,
      codeChallenge: mcpTokens.codeChallenge,
      grantId: mcpGrants.id,
      userId: mcpGrants.userId,
      clientId: mcpGrants.clientId,
      revokedAt: mcpGrants.revokedAt,
      lastUsedAt: mcpGrants.lastUsedAt,
      banned: user.banned,
    })
    .from(mcpTokens)
    .innerJoin(mcpGrants, eq(mcpGrants.id, mcpTokens.grantId))
    .innerJoin(user, eq(user.id, mcpGrants.userId))
    .where(eq(mcpTokens.hash, hashToken(secret)))
    .limit(1);
  return row ?? null;
}
type TokenRow = NonNullable<Awaited<ReturnType<typeof loadToken>>>;

/** Revoke a grant; every code and token under it stops working because each use checks the grant. */
export const revokeGrant = (db: Database, grantId: string, now: number) =>
  db.update(mcpGrants).set({ revokedAt: now }).where(and(eq(mcpGrants.id, grantId), isNull(mcpGrants.revokedAt)));

/** Mark `row` used and issue a fresh token pair in one transaction. Null when a concurrent request consumed it first. */
async function rotate(ctx: OAuthContext, row: TokenRow, scopes: McpScope[]): Promise<Issued | null> {
  const now = ctx.now();
  const access = mintSecret(TokenPrefix.accessToken);
  const refresh = mintSecret(TokenPrefix.refreshToken);
  const scope = McpScope.format(scopes);
  const committed = await ctx.db.transaction(async (tx) => {
    const consumed = await tx
      .update(mcpTokens)
      .set({ consumedAt: now })
      .where(and(eq(mcpTokens.hash, row.hash), isNull(mcpTokens.consumedAt)))
      .returning({ hash: mcpTokens.hash });
    if (consumed.length !== 1) return false;
    await tx.insert(mcpTokens).values([
      { hash: access.hash, kind: "access_token", grantId: row.grantId, scope, expiresAt: now + ACCESS_TOKEN_TTL_MS, createdAt: now },
      { hash: refresh.hash, kind: "refresh_token", grantId: row.grantId, scope, expiresAt: now + REFRESH_TOKEN_TTL_MS, createdAt: now },
    ]);
    return true;
  });
  return committed ? { accessToken: access.secret, refreshToken: refresh.secret, scope } : null;
}

/** Checks shared by both grant types once the presented credential is known to be live. */
function liveGrantError(row: TokenRow, client: OAuthClient, now: number, what: string): ProtocolError | null {
  if (row.expiresAt <= now) return invalidGrant(`The ${what} has expired.`);
  if (row.clientId !== client.clientId) return invalidGrant(`The ${what} was issued to a different client.`);
  if (row.revokedAt !== null) return invalidGrant("This connection was revoked in Nimbus. Authorize the client again.");
  if (row.banned) return invalidGrant("This Nimbus account is disabled. Ask a Nimbus administrator to restore access.");
  return null;
}

async function exchangeCode(ctx: OAuthContext, client: OAuthClient, form: ReadonlyMap<string, string>): Promise<Exchange> {
  const code = form.get("code");
  const redirectUri = form.get("redirect_uri");
  const verifier = form.get("code_verifier");
  if (code === undefined) return { ok: false, error: invalidRequest("code is required.") };
  if (redirectUri === undefined) return { ok: false, error: invalidRequest("redirect_uri is required.") };
  if (verifier === undefined) return { ok: false, error: invalidRequest("code_verifier is required (PKCE).") };
  const now = ctx.now();
  const row = code.startsWith(TokenPrefix.authorizationCode) ? await loadToken(ctx.db, code) : null;
  if (!row || row.kind !== "authorization_code") return { ok: false, error: invalidGrant("The authorization code is invalid.") };
  if (row.consumedAt !== null) {
    if (row.clientId === client.clientId && now - row.consumedAt <= AUTHORIZATION_CODE_REPLAY_WINDOW_MS) {
      await revokeGrant(ctx.db, row.grantId, now);
      return { ok: false, error: invalidGrant("The authorization code was already used, so this connection was revoked to protect the account. Authorize the client again.") };
    }
    return { ok: false, error: invalidGrant("The authorization code was already used. Start the authorization again.") };
  }
  const live = liveGrantError(row, client, now, "authorization code");
  if (live) return { ok: false, error: live };
  if (row.redirectUri !== redirectUri) return { ok: false, error: invalidGrant("redirect_uri does not match the authorization request.") };
  if (row.codeChallenge === null || !codeVerifier.test(verifier) || !constantTimeEqual(s256(verifier), row.codeChallenge))
    return { ok: false, error: invalidGrant("PKCE verification failed: code_verifier does not match code_challenge.") };
  const resource = form.get("resource");
  if (resource !== undefined && resource !== mcpResource(ctx.origin))
    return { ok: false, error: protocolError(400, "invalid_target", `resource must be ${mcpResource(ctx.origin)}.`) };
  const issued = await rotate(ctx, row, McpScope.parse(row.scope).scopes);
  if (issued) return { ok: true, value: issued };
  await revokeGrant(ctx.db, row.grantId, now);
  return { ok: false, error: invalidGrant("The authorization code was used twice at once, so this connection was revoked. Authorize the client again.") };
}

async function refresh(ctx: OAuthContext, client: OAuthClient, form: ReadonlyMap<string, string>): Promise<Exchange> {
  const token = form.get("refresh_token");
  if (token === undefined) return { ok: false, error: invalidRequest("refresh_token is required.") };
  const now = ctx.now();
  const row = token.startsWith(TokenPrefix.refreshToken) ? await loadToken(ctx.db, token) : null;
  if (!row || row.kind !== "refresh_token") return { ok: false, error: invalidGrant("The refresh token is invalid.") };
  if (row.consumedAt !== null) {
    if (row.clientId === client.clientId && now - row.consumedAt > REFRESH_REUSE_GRACE_MS) {
      // An old refresh token reappearing means two parties hold it.
      await revokeGrant(ctx.db, row.grantId, now);
      return { ok: false, error: invalidGrant("This refresh token was already used, so this connection was revoked to protect the account. Authorize the client again.") };
    }
    return { ok: false, error: invalidGrant("The refresh token was already used. Use the newest one.") };
  }
  const live = liveGrantError(row, client, now, "refresh token");
  if (live) return { ok: false, error: live };
  const granted = McpScope.parse(row.scope).scopes;
  let scopes = granted;
  const requested = form.get("scope");
  if (requested !== undefined) {
    const parsed = McpScope.parse(requested);
    if (parsed.unknown.length || !parsed.scopes.length || !McpScope.includesAll(granted, parsed.scopes))
      return { ok: false, error: protocolError(400, "invalid_scope", `scope may only narrow the granted scopes (${McpScope.format(granted)}).`) };
    scopes = parsed.scopes;
  }
  const issued = await rotate(ctx, row, scopes);
  return issued ? { ok: true, value: issued } : { ok: false, error: invalidGrant("The refresh token was already used. Use the newest one.") };
}

/** POST /oauth/token: authorization_code with PKCE, and refresh_token with rotation. */
export async function handleToken(ctx: OAuthContext, request: Request) {
  const address = clientAddress(request);
  const perAddress = hit([{ key: `token:${address}`, rule: throttleRules.tokenPerAddress }], ctx.now());
  if (!perAddress.allowed) return throttled(perAddress.retryAfterSeconds);
  const form = await readForm(request);
  if (!form.ok) return errorResponse(form.error);
  const client = await authenticateClient(ctx.db, request, form.value);
  if (!client.ok) return errorResponse(client.error);
  const perClient = hit([{ key: `token:${client.value.clientId}:${address}`, rule: throttleRules.tokenPerClient }], ctx.now());
  if (!perClient.allowed) return throttled(perClient.retryAfterSeconds);
  const grantType = form.value.get("grant_type");
  const result: Exchange =
    grantType === "authorization_code"
      ? await exchangeCode(ctx, client.value, form.value)
      : grantType === "refresh_token"
        ? await refresh(ctx, client.value, form.value)
        : {
            ok: false,
            error:
              grantType === undefined
                ? invalidRequest("grant_type is required.")
                : protocolError(400, "unsupported_grant_type", "Supported grant types: authorization_code, refresh_token."),
          };
  // Rows outlive expiry long enough for replay detection, then go.
  await ctx.db.delete(mcpTokens).where(lt(mcpTokens.expiresAt, ctx.now() - AUTHORIZATION_CODE_REPLAY_WINDOW_MS));
  if (!result.ok) return errorResponse(result.error);
  return json({
    access_token: result.value.accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_MS / 1000,
    refresh_token: result.value.refreshToken,
    scope: result.value.scope,
  });
}

/**
 * POST /oauth/revoke (RFC 7009). Revoking a refresh or access token revokes its
 * whole connection. Unknown tokens still get 200. A client that identifies
 * itself must authenticate and may revoke only its own connections.
 */
export async function handleRevoke(ctx: OAuthContext, request: Request) {
  const form = await readForm(request);
  if (!form.ok) return errorResponse(form.error);
  const token = form.value.get("token");
  if (token === undefined) return errorResponse(invalidRequest("token is required."));
  let clientId: string | null = null;
  if (presentsCredentials(request, form.value)) {
    const client = await authenticateClient(ctx.db, request, form.value);
    if (!client.ok) return errorResponse(client.error);
    clientId = client.value.clientId;
  }
  const row = await loadToken(ctx.db, token);
  if (row && row.kind !== "authorization_code" && (clientId === null || row.clientId === clientId))
    await revokeGrant(ctx.db, row.grantId, ctx.now());
  return new Response(null, { status: 200, headers: { ...corsHeaders, "Cache-Control": "no-store" } });
}

export type BearerAuth =
  | { kind: "authenticated"; userId: string; grantId: string; clientId: string; scopes: McpScope[] }
  | { kind: "missing" }
  | { kind: "rejected"; message: string };

const LAST_USED_RESOLUTION_MS = 60 * 1000;

/** Verify "Authorization: Bearer" for the MCP endpoint against the live grant and account. */
export async function authenticateBearer(ctx: Pick<OAuthContext, "db" | "now">, request: Request): Promise<BearerAuth> {
  const header = request.headers.get("authorization");
  if (header === null) return { kind: "missing" };
  const token = /^Bearer +(\S+)\s*$/i.exec(header)?.[1];
  if (!token?.startsWith(TokenPrefix.accessToken))
    return { kind: "rejected", message: "The access token is not a Nimbus MCP access token. Authorize the client again." };
  const row = await loadToken(ctx.db, token);
  const now = ctx.now();
  if (!row || row.kind !== "access_token")
    return { kind: "rejected", message: "The access token is invalid. Refresh it or authorize the client again." };
  if (row.expiresAt <= now) return { kind: "rejected", message: "The access token has expired. Refresh it with the refresh token." };
  if (row.revokedAt !== null)
    return { kind: "rejected", message: "This connection was revoked in Nimbus. Authorize the client again." };
  if (row.banned)
    return { kind: "rejected", message: "This Nimbus account is disabled. Ask a Nimbus administrator to restore access." };
  if (row.lastUsedAt === null || row.lastUsedAt <= now - LAST_USED_RESOLUTION_MS)
    await ctx.db.update(mcpGrants).set({ lastUsedAt: now }).where(eq(mcpGrants.id, row.grantId));
  return { kind: "authenticated", userId: row.userId, grantId: row.grantId, clientId: row.clientId, scopes: McpScope.parse(row.scope).scopes };
}
