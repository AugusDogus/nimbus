import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { McpScope } from "@nimbus/api/mcp-scope";
import { and, eq, lt, notExists } from "drizzle-orm";
import { z } from "zod";
import {
  mcpClients,
  mcpGrants,
  OAUTH_CLIENT_AUTH_METHODS,
  type OAuthClientAuthMethod,
} from "../../db/mcp-schema";
import type { Database, OAuthContext } from "./context";
import { clientAddress, errorResponse, json, protocolError, readJsonObject, type Parsed, type ProtocolError } from "./http";
import { validateRedirectUri, validateWebUri } from "./redirect-uri";
import { hit, throttleRules } from "../throttle";

export const DEFAULT_CLIENT_NAME = "MCP client";
const MAX_CLIENT_NAME_LENGTH = 200;
const MAX_REDIRECT_URIS = 10;
/** Clients register right before authorizing; a registration never approved is dropped after a day. */
export const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;

export type OAuthClient = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  authMethod: OAuthClientAuthMethod;
  clientSecretHash: string | null;
  scopes: McpScope[];
};

export const hashSecret = (secret: string) => createHash("sha256").update(secret, "utf8").digest("base64url");

export const constantTimeEqual = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

type Registration = {
  redirectUris: string[];
  clientName: string;
  authMethod: OAuthClientAuthMethod;
  scopes: McpScope[];
  clientUri: string | null;
};

const invalidMetadata = (description: string) => protocolError(400, "invalid_client_metadata", description);
const isAuthMethod = (value: unknown): value is OAuthClientAuthMethod =>
  OAUTH_CLIENT_AUTH_METHODS.some((method) => method === value);

function checkList(body: Record<string, unknown>, field: string, allowed: readonly string[], required: string | null) {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    return invalidMetadata(`${field} must be an array of strings.`);
  const unsupported = value.filter((item) => !allowed.includes(item));
  if (unsupported.length)
    return invalidMetadata(`${field} contains unsupported values (${unsupported.join(", ")}); supported: ${allowed.join(", ")}.`);
  if (required !== null && !value.includes(required)) return invalidMetadata(`${field} must include ${required}.`);
  return null;
}

/** Validate an RFC 7591 client metadata document. */
export function parseRegistration(body: Record<string, unknown>): Parsed<Registration> {
  const fail = (error: ProtocolError) => ({ ok: false as const, error });
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0)
    return fail(protocolError(400, "invalid_redirect_uri", "redirect_uris must be a non-empty array."));
  if (uris.length > MAX_REDIRECT_URIS)
    return fail(protocolError(400, "invalid_redirect_uri", `At most ${MAX_REDIRECT_URIS} redirect_uris may be registered.`));
  const redirectUris: string[] = [];
  for (const [index, uri] of uris.entries()) {
    const checked = validateRedirectUri(uri);
    if (!checked.ok)
      return fail(protocolError(400, "invalid_redirect_uri", `redirect_uris[${index}] is invalid: ${checked.reason}.`));
    redirectUris.push(checked.value);
  }
  const rawName = body.client_name;
  if (rawName !== undefined && rawName !== null && typeof rawName !== "string")
    return fail(invalidMetadata("client_name must be a string."));
  const clientName = typeof rawName === "string" && rawName.trim() !== "" ? rawName.trim() : DEFAULT_CLIENT_NAME;
  if (clientName.length > MAX_CLIENT_NAME_LENGTH)
    return fail(invalidMetadata(`client_name must be at most ${MAX_CLIENT_NAME_LENGTH} characters.`));
  const authMethod = body.token_endpoint_auth_method ?? "none";
  if (!isAuthMethod(authMethod))
    return fail(invalidMetadata(`token_endpoint_auth_method must be one of ${OAUTH_CLIENT_AUTH_METHODS.join(", ")}.`));
  const listError =
    checkList(body, "grant_types", ["authorization_code", "refresh_token"], "authorization_code") ??
    checkList(body, "response_types", ["code"], null);
  if (listError) return fail(listError);
  const rawScope = body.scope;
  if (rawScope !== undefined && rawScope !== null && typeof rawScope !== "string")
    return fail(invalidMetadata("scope must be a space-separated string."));
  // Unknown scopes (such as openid) are ignored; a client asking for none of ours may request all.
  const requested = typeof rawScope === "string" ? McpScope.parse(rawScope).scopes : [];
  let clientUri: string | null = null;
  if (body.client_uri !== undefined && body.client_uri !== null) {
    const checked = validateWebUri(body.client_uri);
    if (!checked.ok) return fail(invalidMetadata(`client_uri is invalid: ${checked.reason}.`));
    clientUri = checked.value;
  }
  return {
    ok: true,
    value: { redirectUris, clientName, authMethod, scopes: requested.length ? requested : [...McpScope.all], clientUri },
  };
}

const tooManyRequests = (retryAfterSeconds: number) =>
  protocolError(429, "slow_down", `Too many requests. Nothing was registered or issued; retry after ${retryAfterSeconds} seconds.`, {
    "Retry-After": String(retryAfterSeconds),
  });
export const throttled = (retryAfterSeconds: number) => errorResponse(tooManyRequests(retryAfterSeconds));

/** POST /oauth/register (RFC 7591). Registration is open, so it is bounded per address and globally. */
export async function registerClient(ctx: OAuthContext, request: Request) {
  const now = ctx.now();
  const perAddress = hit([{ key: `register:${clientAddress(request)}`, rule: throttleRules.registerPerAddress }], now);
  if (!perAddress.allowed) return throttled(perAddress.retryAfterSeconds);
  const body = await readJsonObject(request);
  if (!body.ok) return errorResponse(body.error);
  const parsed = parseRegistration(body.value);
  if (!parsed.ok) return errorResponse(parsed.error);
  // Counted only for valid registrations, the ones that store a row.
  const global = hit([{ key: "register:global", rule: throttleRules.registerGlobal }], now);
  if (!global.allowed) return throttled(global.retryAfterSeconds);
  const registration = parsed.value;
  const clientId = randomBytes(18).toString("base64url");
  const clientSecret = registration.authMethod === "none" ? null : `nimbus_cs_${randomBytes(32).toString("base64url")}`;
  const scope = McpScope.format(registration.scopes);
  await ctx.db.insert(mcpClients).values({
    clientId,
    clientName: registration.clientName,
    redirectUrisJson: JSON.stringify(registration.redirectUris),
    tokenEndpointAuthMethod: registration.authMethod,
    clientSecretHash: clientSecret === null ? null : hashSecret(clientSecret),
    scope,
    clientUri: registration.clientUri,
    createdAt: now,
  });
  await ctx.db
    .delete(mcpClients)
    .where(
      and(
        lt(mcpClients.createdAt, now - UNUSED_CLIENT_TTL_MS),
        notExists(ctx.db.select({ id: mcpGrants.id }).from(mcpGrants).where(eq(mcpGrants.clientId, mcpClients.clientId))),
      ),
    );
  return json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(now / 1000),
      ...(clientSecret === null ? {} : { client_secret: clientSecret, client_secret_expires_at: 0 }),
      client_name: registration.clientName,
      redirect_uris: registration.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: registration.authMethod,
      scope,
      ...(registration.clientUri === null ? {} : { client_uri: registration.clientUri }),
    },
    { status: 201 },
  );
}

const redirectUrisSchema = z.array(z.string());

export async function findClient(db: Database, clientId: string): Promise<OAuthClient | null> {
  const [row] = await db.select().from(mcpClients).where(eq(mcpClients.clientId, clientId)).limit(1);
  if (!row) return null;
  return {
    clientId: row.clientId,
    clientName: row.clientName,
    redirectUris: redirectUrisSchema.parse(JSON.parse(row.redirectUrisJson)),
    authMethod: row.tokenEndpointAuthMethod,
    clientSecretHash: row.clientSecretHash,
    scopes: McpScope.parse(row.scope).scopes,
  };
}

type Presented =
  | { method: "client_secret_basic" | "client_secret_post"; clientId: string; secret: string }
  | { method: "none"; clientId: string };

const basicChallenge = { "WWW-Authenticate": 'Basic realm="Nimbus"' };
const invalidClient = (description: string, basic: boolean) =>
  protocolError(401, "invalid_client", description, basic ? basicChallenge : undefined);

function decodeComponent(value: string) {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return undefined;
  }
}

function presentedCredentials(request: Request, form: ReadonlyMap<string, string>): Parsed<Presented | null> {
  const authorization = request.headers.get("authorization");
  const bodyClientId = form.get("client_id");
  if (authorization !== null && /^basic /i.test(authorization)) {
    const decoded = Buffer.from(authorization.slice(6).trim(), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    const clientId = separator > 0 ? decodeComponent(decoded.slice(0, separator)) : undefined;
    const secret = separator > 0 ? decodeComponent(decoded.slice(separator + 1)) : undefined;
    if (clientId === undefined || !secret)
      return { ok: false, error: invalidClient("The Basic authorization header is malformed.", true) };
    if (form.has("client_secret"))
      return { ok: false, error: invalidClient("Use only one client authentication method.", true) };
    if (bodyClientId !== undefined && bodyClientId !== clientId)
      return { ok: false, error: protocolError(400, "invalid_request", "client_id does not match the Basic credentials.") };
    return { ok: true, value: { method: "client_secret_basic", clientId, secret } };
  }
  if (bodyClientId === undefined) return { ok: true, value: null };
  const secret = form.get("client_secret");
  return {
    ok: true,
    value: secret === undefined ? { method: "none", clientId: bodyClientId } : { method: "client_secret_post", clientId: bodyClientId, secret },
  };
}

export const presentsCredentials = (request: Request, form: ReadonlyMap<string, string>) =>
  form.has("client_id") || /^basic /i.test(request.headers.get("authorization") ?? "");

/** Authenticate the client of a token or revocation request with its registered method. */
export async function authenticateClient(
  db: Database,
  request: Request,
  form: ReadonlyMap<string, string>,
): Promise<Parsed<OAuthClient>> {
  const presented = presentedCredentials(request, form);
  if (!presented.ok) return presented;
  const credentials = presented.value;
  if (credentials === null)
    return { ok: false, error: invalidClient("client_id is required (or client credentials in a Basic header).", false) };
  const basic = credentials.method === "client_secret_basic";
  const client = await findClient(db, credentials.clientId);
  if (!client) return { ok: false, error: invalidClient("Unknown client. Register the client again.", basic) };
  if (client.authMethod !== credentials.method)
    return { ok: false, error: invalidClient(`This client is registered for token_endpoint_auth_method ${client.authMethod}.`, basic) };
  if (
    credentials.method !== "none" &&
    (client.clientSecretHash === null || !constantTimeEqual(hashSecret(credentials.secret), client.clientSecretHash))
  )
    return { ok: false, error: invalidClient("Client authentication failed.", basic) };
  return { ok: true, value: client };
}
