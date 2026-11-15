import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";
import { McpScope } from "@nimbus/api/mcp-scope";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { mcpGrants, mcpTokens } from "../../db/mcp-schema";
import { mcpResource } from "../config";
import { findClient, type OAuthClient } from "./clients";
import type { BrowserSession, OAuthContext } from "./context";
import { htmlError, seeOther } from "./http";
import { AUTHORIZATION_CODE_TTL_MS, mintSecret, TokenPrefix } from "./secrets";

/** A validated authorization request (RFC 6749 4.1.1 with PKCE and RFC 8707). */
export type AuthorizationRequest = {
  clientId: string;
  redirectUri: string;
  scopes: McpScope[];
  state: string | null;
  codeChallenge: string;
  resource: string | null;
};

/**
 * The outcome of checking an authorization request. `untrusted`: the client or
 * redirect URI cannot be trusted, so the user sees an error and is never
 * redirected. `invalid`: the client is known, but the request is malformed.
 */
export type Validation =
  | { kind: "valid"; request: AuthorizationRequest; client: OAuthClient }
  | { kind: "untrusted"; message: string }
  | { kind: "invalid"; redirectUri: string; state: string | null; error: string; description: string };

const MAX_STATE_LENGTH = 2048;
const s256Challenge = /^[A-Za-z0-9_-]{43}$/;
const restart = "Nothing was shared. Return to the app you were connecting and start again.";

export async function validateAuthorization(ctx: OAuthContext, params: URLSearchParams): Promise<Validation> {
  const clientIds = params.getAll("client_id");
  const redirectUris = params.getAll("redirect_uri");
  const clientId = clientIds[0];
  if (clientIds.length !== 1 || !clientId)
    return { kind: "untrusted", message: `This request does not name exactly one app (client_id). ${restart}` };
  const client = await findClient(ctx.db, clientId);
  if (!client) return { kind: "untrusted", message: `The app requesting access is not registered with this Nimbus server. ${restart}` };
  const redirectUri = redirectUris[0];
  if (redirectUris.length !== 1 || redirectUri === undefined)
    return { kind: "untrusted", message: `This request must include exactly one redirect_uri. ${restart}` };
  if (!client.redirectUris.includes(redirectUri))
    return {
      kind: "untrusted",
      message: `The redirect_uri does not exactly match one this app registered, so Nimbus will not send you there. ${restart}`,
    };
  const rawState = params.getAll("state");
  const state = rawState.length === 1 && rawState[0] ? rawState[0] : null;
  const invalid = (error: string, description: string): Validation => ({
    kind: "invalid",
    redirectUri,
    state: state !== null && state.length <= MAX_STATE_LENGTH ? state : null,
    error,
    description,
  });
  for (const key of new Set(params.keys()))
    if (params.getAll(key).length > 1) return invalid("invalid_request", `The "${key}" parameter must not be repeated.`);
  if (state !== null && state.length > MAX_STATE_LENGTH)
    return invalid("invalid_request", `state must be at most ${MAX_STATE_LENGTH} characters.`);
  const responseType = params.get("response_type");
  if (!responseType) return invalid("invalid_request", "response_type is required (use code).");
  if (responseType !== "code") return invalid("unsupported_response_type", "Only response_type=code is supported.");
  const codeChallenge = params.get("code_challenge");
  if (!codeChallenge) return invalid("invalid_request", "PKCE is required: send code_challenge with code_challenge_method=S256.");
  if (params.get("code_challenge_method") !== "S256")
    return invalid("invalid_request", "code_challenge_method must be S256 (plain is not supported).");
  if (!s256Challenge.test(codeChallenge))
    return invalid("invalid_request", "code_challenge must be the 43-character base64url SHA-256 of the code verifier.");
  const resource = params.get("resource");
  if (resource !== null && resource !== mcpResource(ctx.origin))
    return invalid("invalid_target", `resource must be ${mcpResource(ctx.origin)}.`);
  const scopeParam = params.get("scope");
  const requested = scopeParam?.trim() ? McpScope.parse(scopeParam).scopes : client.scopes;
  const scopes = McpScope.intersect(requested, client.scopes);
  if (!scopes.length)
    return invalid("invalid_scope", `None of the requested scopes are available to this app; supported: ${McpScope.format(client.scopes)}.`);
  return { kind: "valid", client, request: { clientId: client.clientId, redirectUri, scopes, state, codeChallenge, resource } };
}

/** Canonical query string of a validated request, for the consent page URL. */
export function authorizationParams(request: AuthorizationRequest) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    scope: McpScope.format(request.scopes),
    code_challenge: request.codeChallenge,
    code_challenge_method: "S256",
  });
  if (request.state !== null) params.set("state", request.state);
  if (request.resource !== null) params.set("resource", request.resource);
  return params;
}

/** `redirectUri` with response parameters and `iss` (RFC 9207). */
export function clientRedirect(ctx: Pick<OAuthContext, "origin">, redirectUri: string, params: Record<string, string | null>) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) if (value !== null) url.searchParams.set(key, value);
  url.searchParams.set("iss", ctx.origin);
  return url.toString();
}

export const signInUrl = (returnTo: string) => `/login?${new URLSearchParams({ callbackURL: returnTo })}`;

const unavailable = () =>
  htmlError(503, "Authorization unavailable", "Nimbus could not check this request right now. Nothing was shared. Try again in a moment.");

/**
 * GET /oauth/authorize. Invalid requests show an error page and never redirect:
 * every redirect URI comes from open registration, so redirecting on error
 * would make Nimbus an open redirector (RFC 9700 section 4.11.2). Only the
 * user's own decision on the consent page redirects back to the app.
 */
export async function handleAuthorize(ctx: OAuthContext, request: Request) {
  const url = new URL(request.url);
  let validation: Validation;
  let session: BrowserSession | null;
  try {
    validation = await validateAuthorization(ctx, url.searchParams);
    if (validation.kind !== "valid") return htmlError(400, "Cannot connect this app", validationMessage(validation));
    session = await ctx.getSession(request.headers);
  } catch (error) {
    console.error(`[mcp-oauth] authorize failed: ${error instanceof Error ? error.name : typeof error}`);
    return unavailable();
  }
  const consent = `/oauth/consent?${authorizationParams(validation.request)}`;
  return new Response(null, {
    status: 302,
    headers: { Location: session ? consent : signInUrl(consent), "Cache-Control": "no-store" },
  });
}

export const validationMessage = (validation: Exclude<Validation, { kind: "valid" }>) =>
  validation.kind === "untrusted"
    ? validation.message
    : `This authorization request is invalid (${validation.error}): ${validation.description} ${restart}`;

/* Consent tickets: CSRF protection for the consent form, bound to the browser
 * session and the exact request shown, signed with a key derived from
 * BETTER_AUTH_SECRET. Format: base64url(JSON) "." base64url(HMAC-SHA256). */

export const CONSENT_TICKET_TTL_MS = 10 * 60 * 1000;

const ticketClaims = z.object({
  v: z.literal(1),
  sid: z.string().min(1),
  uid: z.string().min(1),
  exp: z.number().int(),
  req: z.object({
    clientId: z.string(),
    redirectUri: z.string(),
    scope: z.string(),
    state: z.string().nullable(),
    codeChallenge: z.string(),
    resource: z.string().nullable(),
  }),
});

const ticketMac = (secret: string, payload: string) =>
  createHmac("sha256", new Uint8Array(hkdfSync("sha256", secret, new Uint8Array(0), "nimbus/mcp-consent/v1", 32)))
    .update(payload)
    .digest();

export function issueConsentTicket(ctx: Pick<OAuthContext, "secret" | "now">, session: BrowserSession, request: AuthorizationRequest) {
  const claims: z.infer<typeof ticketClaims> = {
    v: 1,
    sid: session.sessionId,
    uid: session.userId,
    exp: ctx.now() + CONSENT_TICKET_TTL_MS,
    req: { ...request, scope: McpScope.format(request.scopes) },
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${ticketMac(ctx.secret, payload).toString("base64url")}`;
}

type TicketCheck = { ok: true; request: AuthorizationRequest } | { ok: false; message: string };

export function verifyConsentTicket(ctx: Pick<OAuthContext, "secret" | "now">, ticket: string, session: BrowserSession): TicketCheck {
  const expired = { ok: false as const, message: `This approval form is invalid or has expired. ${restart}` };
  const [payload, signature, extra] = ticket.split(".");
  if (!payload || !signature || extra !== undefined) return expired;
  const presented = Buffer.from(signature, "base64url");
  const expected = ticketMac(ctx.secret, payload);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return expired;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return expired;
  }
  const parsed = ticketClaims.safeParse(json);
  if (!parsed.success || parsed.data.exp <= ctx.now()) return expired;
  if (parsed.data.sid !== session.sessionId || parsed.data.uid !== session.userId)
    return { ok: false, message: `This approval form belongs to a different sign-in session. ${restart}` };
  const { scope, ...request } = parsed.data.req;
  return { ok: true, request: { ...request, scopes: McpScope.parse(scope).scopes } };
}

/** What the consent page renders. */
export type ConsentView =
  | { kind: "invalid"; message: string }
  | { kind: "sign_in"; url: string }
  | { kind: "ready"; clientName: string; redirectTarget: string; scopes: McpScope[]; ticket: string };

/** Host (or scheme, for native apps) the user returns to after deciding. */
export function redirectTarget(redirectUri: string) {
  const url = new URL(redirectUri);
  return url.host !== "" ? url.host : url.protocol;
}

export async function loadConsent(ctx: OAuthContext, params: URLSearchParams, headers: Headers): Promise<ConsentView> {
  const validation = await validateAuthorization(ctx, params);
  if (validation.kind !== "valid") return { kind: "invalid", message: validationMessage(validation) };
  const session = await ctx.getSession(headers);
  if (!session) return { kind: "sign_in", url: signInUrl(`/oauth/consent?${authorizationParams(validation.request)}`) };
  return {
    kind: "ready",
    clientName: validation.client.clientName,
    redirectTarget: redirectTarget(validation.request.redirectUri),
    scopes: validation.request.scopes,
    ticket: issueConsentTicket(ctx, session, validation.request),
  };
}

/** Optional scopes appear as checkboxes on the consent form; reading is always part of an approval. */
export const optionalScopeFields: Partial<Record<McpScope, string>> = {
  "files:write": "allow_write",
  "files:share": "allow_share",
};

async function issueCode(ctx: OAuthContext, session: BrowserSession, request: AuthorizationRequest, scopes: McpScope[]) {
  const now = ctx.now();
  const grantId = randomUUID();
  const code = mintSecret(TokenPrefix.authorizationCode);
  const scope = McpScope.format(scopes);
  await ctx.db.batch([
    // Reconnecting the same app replaces its previous approval, so Settings lists one entry per app.
    ctx.db
      .update(mcpGrants)
      .set({ revokedAt: now })
      .where(and(eq(mcpGrants.userId, session.userId), eq(mcpGrants.clientId, request.clientId), isNull(mcpGrants.revokedAt))),
    ctx.db.insert(mcpGrants).values({ id: grantId, userId: session.userId, clientId: request.clientId, scope, createdAt: now }),
    ctx.db.insert(mcpTokens).values({
      hash: code.hash,
      kind: "authorization_code",
      grantId,
      scope,
      expiresAt: now + AUTHORIZATION_CODE_TTL_MS,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      createdAt: now,
    }),
  ]);
  return code.secret;
}

/**
 * POST /oauth/consent. CSRF: the Origin must be Nimbus and the ticket must be
 * valid, unexpired, and bound to the current session. The request is checked
 * again against the current registration before anything is issued.
 */
export async function decideConsent(ctx: OAuthContext, request: Request) {
  if (request.headers.get("origin") !== ctx.origin)
    return htmlError(403, "Request blocked", "This approval did not come from the Nimbus consent page. Nothing was shared.");
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await request.text());
  } catch {
    return htmlError(400, "Cannot process approval", `The approval form could not be read. ${restart}`);
  }
  const ticket = form.get("ticket");
  const decision = form.get("decision");
  if (!ticket || (decision !== "approve" && decision !== "deny"))
    return htmlError(400, "Cannot process approval", `The approval form is incomplete. ${restart}`);
  try {
    const session = await ctx.getSession(request.headers);
    if (!session)
      return htmlError(401, "Signed out", `Your Nimbus session ended before you decided. ${restart}`);
    const checked = verifyConsentTicket(ctx, ticket, session);
    if (!checked.ok) return htmlError(400, "Approval expired", checked.message);
    const validation = await validateAuthorization(ctx, authorizationParams(checked.request));
    if (validation.kind === "untrusted") return htmlError(400, "Cannot connect this app", validation.message);
    if (validation.kind === "invalid")
      return seeOther(clientRedirect(ctx, validation.redirectUri, { error: validation.error, error_description: validation.description, state: validation.state }));
    const authorization = validation.request;
    if (decision === "deny")
      return seeOther(clientRedirect(ctx, authorization.redirectUri, { error: "access_denied", error_description: "The user denied access.", state: authorization.state }));
    const scopes = authorization.scopes.filter((scope) => {
      const field = optionalScopeFields[scope];
      return field === undefined || form.get(field) === "on";
    });
    if (!scopes.length)
      return seeOther(clientRedirect(ctx, authorization.redirectUri, { error: "access_denied", error_description: "The user approved no permissions.", state: authorization.state }));
    const code = await issueCode(ctx, session, authorization, scopes);
    return seeOther(clientRedirect(ctx, authorization.redirectUri, { code, state: authorization.state }));
  } catch (error) {
    console.error(`[mcp-oauth] consent failed: ${error instanceof Error ? error.name : typeof error}`);
    return unavailable();
  }
}
