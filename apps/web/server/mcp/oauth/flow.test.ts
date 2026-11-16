import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { flushAudit, resetAuditForTest, setAuditSink, type RecordedAuditEvent } from "@nimbus/api/audit";
import * as schema from "../../db/schema";
import { resetThrottleForTest } from "../throttle";
import { decideConsent, handleAuthorize, loadConsent } from "./authorization";
import { registerClient } from "./clients";
import { listConnections, revokeConnection } from "./connections";
import type { BrowserSession, OAuthContext } from "./context";
import { authenticateBearer, handleRevoke, handleToken } from "./tokens";

const origin = "https://files.example.test";
const redirectUri = "http://127.0.0.1:33418/callback";
const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

describe("MCP OAuth flow", () => {
  let client: Client;
  let directory: string;
  let ctx: OAuthContext;
  let now: number;
  let session: BrowserSession | null;

  const post = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
    new Request(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(body),
    });

  const register = async (metadata: Record<string, unknown> = {}) => {
    const response = await registerClient(
      ctx,
      new Request(`${origin}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Claude Code", redirect_uris: [redirectUri], ...metadata }),
      }),
    );
    expect(response.status).toBe(201);
    const body: { client_id: string } = await response.json();
    return body.client_id;
  };

  const pkce = () => {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
  };

  const authorizeParams = (clientId: string, challenge: string, extra: Record<string, string> = {}) =>
    new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "client-state",
      resource: `${origin}/api/mcp`,
      ...extra,
    });

  /** Approve through the consent page as `session` and return the code. */
  const approve = async (clientId: string, challenge: string, form: Record<string, string> = { allow_write: "on", allow_share: "on" }) => {
    const view = await loadConsent(ctx, authorizeParams(clientId, challenge), new Headers());
    if (view.kind !== "ready") throw new Error(`Expected a consent form, got ${view.kind}`);
    const response = await decideConsent(ctx, post("/oauth/consent", { ticket: view.ticket, decision: "approve", ...form }, { origin }));
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("state")).toBe("client-state");
    expect(location.searchParams.get("iss")).toBe(origin);
    return location.searchParams.get("code") ?? "";
  };

  const exchange = async (clientId: string, code: string, verifier: string) =>
    handleToken(ctx, post("/oauth/token", { grant_type: "authorization_code", client_id: clientId, code, redirect_uri: redirectUri, code_verifier: verifier }));

  const connect = async (form?: Record<string, string>) => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const response = await exchange(clientId, await approve(clientId, challenge, form), verifier);
    expect(response.status).toBe(200);
    const tokens: { access_token: string; refresh_token: string; scope: string } = await response.json();
    return { clientId, ...tokens };
  };

  const bearer = (token: string) =>
    authenticateBearer(ctx, new Request(`${origin}/api/mcp`, { headers: { authorization: `Bearer ${token}` } }));

  beforeEach(async () => {
    // A file, not :memory:, because libsql runs transactions on a separate connection.
    directory = await mkdtemp(path.join(os.tmpdir(), "nimbus-mcp-oauth-"));
    client = createClient({ url: `file:${path.join(directory, "db.sqlite")}` });
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder });
    await client.execute("INSERT INTO user (id, name, email, role) VALUES ('owner', 'Owner', 'owner@example.test', 'admin')");
    now = 1_800_000_000_000;
    session = { userId: "owner", sessionId: "session-1" };
    ctx = { db, origin, secret: "s".repeat(32), now: () => now, getSession: async () => session };
    resetThrottleForTest();
  });
  afterEach(async () => {
    client.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("sends signed-out users to sign-in and back to consent", async () => {
    const clientId = await register();
    session = null;
    const response = await handleAuthorize(ctx, new Request(`${origin}/oauth/authorize?${authorizeParams(clientId, pkce().challenge)}`));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "", origin);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("callbackURL")).toStartWith("/oauth/consent?");
  });

  it("accepts a loopback redirect URI whose host Next.js rewrote, and returns to the registered one", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    // Next.js rewrites 127.0.0.1 to localhost inside request URLs, query values included.
    const params = authorizeParams(clientId, challenge, { redirect_uri: "http://localhost:33418/callback" });
    const view = await loadConsent(ctx, params, new Headers());
    if (view.kind !== "ready") throw new Error(`Expected a consent form, got ${view.kind}`);
    const response = await decideConsent(ctx, post("/oauth/consent", { ticket: view.ticket, decision: "approve" }, { origin }));
    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(redirectUri);
    expect((await exchange(clientId, location.searchParams.get("code") ?? "", verifier)).status).toBe(200);
    const elsewhere = authorizeParams(clientId, challenge, { redirect_uri: "http://localhost:9999/callback" });
    expect(await loadConsent(ctx, elsewhere, new Headers())).toMatchObject({ kind: "invalid" });
  });

  it("never redirects an unregistered redirect URI, even for errors", async () => {
    const clientId = await register();
    const params = authorizeParams(clientId, pkce().challenge, { redirect_uri: "https://attacker.example/callback" });
    const response = await handleAuthorize(ctx, new Request(`${origin}/oauth/authorize?${params}`));
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain("will not send you there");
  });

  it("issues tokens that authenticate MCP requests with the approved scopes", async () => {
    const tokens = await connect();
    expect(tokens.access_token).toStartWith("nimbus_mcp_access_");
    expect(tokens.scope).toBe("files:read files:write files:share");
    expect(await bearer(tokens.access_token)).toMatchObject({ kind: "authenticated", userId: "owner", scopes: ["files:read", "files:write", "files:share"] });
    expect(await listConnections(ctx.db, "owner")).toMatchObject([{ clientName: "Claude Code", lastUsedAt: now }]);
  });

  it("grants only the permissions the user left checked", async () => {
    const tokens = await connect({});
    expect(tokens.scope).toBe("files:read");
  });

  it("requires the PKCE verifier and the original redirect URI", async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const code = await approve(clientId, challenge);
    const wrong = await exchange(clientId, code, pkce().verifier);
    expect(await wrong.json()).toMatchObject({ error: "invalid_grant", error_description: expect.stringContaining("PKCE") });
  });

  it("revokes the connection when its own client replays a used code", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const code = await approve(clientId, challenge);
    const first: { access_token: string } = await (await exchange(clientId, code, verifier)).json();
    expect((await exchange(clientId, code, verifier)).status).toBe(400);
    expect(await bearer(first.access_token)).toMatchObject({ kind: "rejected" });
  });

  it("rotates refresh tokens and treats reuse after the grace window as theft", async () => {
    const tokens = await connect();
    const refresh = (token: string) => handleToken(ctx, post("/oauth/token", { grant_type: "refresh_token", client_id: tokens.clientId, refresh_token: token }));
    const rotated = await refresh(tokens.refresh_token);
    expect(rotated.status).toBe(200);
    const next: { access_token: string; refresh_token: string } = await rotated.json();
    expect((await refresh(tokens.refresh_token)).status).toBe(400);
    expect(await bearer(next.access_token)).toMatchObject({ kind: "authenticated" });
    now += 60_000;
    expect(await (await refresh(tokens.refresh_token)).json()).toMatchObject({ error_description: expect.stringContaining("revoked") });
    expect(await bearer(next.access_token)).toMatchObject({ kind: "rejected" });
  });

  it("refuses to refresh tokens for a different resource", async () => {
    const tokens = await connect();
    const response = await handleToken(ctx, post("/oauth/token", { grant_type: "refresh_token", client_id: tokens.clientId, refresh_token: tokens.refresh_token, resource: "https://other.example/mcp" }));
    expect(await response.json()).toMatchObject({ error: "invalid_target" });
  });

  it("rejects expired access tokens", async () => {
    const tokens = await connect();
    now += 60 * 60 * 1000;
    expect(await bearer(tokens.access_token)).toMatchObject({ kind: "rejected", message: expect.stringContaining("expired") });
  });

  it("cuts off a disabled account immediately", async () => {
    await client.execute("INSERT INTO user (id, name, email) VALUES ('member', 'Member', 'member@example.test')");
    session = { userId: "member", sessionId: "session-2" };
    const tokens = await connect();
    await ctx.db.update(schema.user).set({ banned: true }).where(eq(schema.user.id, "member"));
    expect(await bearer(tokens.access_token)).toMatchObject({ kind: "rejected", message: expect.stringContaining("disabled") });
  });

  it("lets the user revoke a connection from Settings and a client revoke its own token", async () => {
    const first = await connect();
    const [connection] = await listConnections(ctx.db, "owner");
    if (!connection) throw new Error("Expected a connection");
    expect(await revokeConnection(ctx.db, "someone-else", connection.id, now)).toBe(false);
    expect(await revokeConnection(ctx.db, "owner", connection.id, now)).toBe(true);
    expect(await bearer(first.access_token)).toMatchObject({ kind: "rejected", message: expect.stringContaining("revoked") });
    const second = await connect();
    expect((await handleRevoke(ctx, post("/oauth/revoke", { token: second.refresh_token, client_id: second.clientId }))).status).toBe(200);
    expect(await bearer(second.access_token)).toMatchObject({ kind: "rejected" });
    expect(await listConnections(ctx.db, "owner")).toEqual([]);
  });

  it("records approvals, refused token requests, and disconnections in the audit log", async () => {
    resetAuditForTest();
    const events: RecordedAuditEvent[] = [];
    setAuditSink(async (batch) => void events.push(...batch));
    try {
      const first = await connect();
      expect((await handleToken(ctx, post("/oauth/token", { grant_type: "refresh_token", client_id: first.clientId, refresh_token: "not-a-token" }))).status).toBe(400);
      const [connection] = await listConnections(ctx.db, "owner");
      if (!connection) throw new Error("Expected a connection");
      await revokeConnection(ctx.db, "owner", connection.id, now);
      await flushAudit();
      expect(events.map(({ action, actor, target }) => ({ action, actor: actor.type, target: target?.type }))).toEqual([
        { action: "mcp.client_approved", actor: "user", target: "mcp_client" },
        { action: "mcp.token_failed", actor: "anonymous", target: "mcp_client" },
        { action: "mcp.client_disconnected", actor: "user", target: "mcp_client" },
      ]);
      expect(JSON.stringify(events)).not.toContain(first.refresh_token);
    } finally {
      resetAuditForTest();
    }
  });

  it("refuses consent decisions from other origins or sessions", async () => {
    const clientId = await register();
    const view = await loadConsent(ctx, authorizeParams(clientId, pkce().challenge), new Headers());
    if (view.kind !== "ready") throw new Error("Expected a consent form");
    expect((await decideConsent(ctx, post("/oauth/consent", { ticket: view.ticket, decision: "approve" }, { origin: "https://evil.example" }))).status).toBe(403);
    session = { userId: "owner", sessionId: "other-session" };
    expect((await decideConsent(ctx, post("/oauth/consent", { ticket: view.ticket, decision: "approve" }, { origin }))).status).toBe(400);
  });

  it("reports denial to the client", async () => {
    const clientId = await register();
    const view = await loadConsent(ctx, authorizeParams(clientId, pkce().challenge), new Headers());
    if (view.kind !== "ready") throw new Error("Expected a consent form");
    const response = await decideConsent(ctx, post("/oauth/consent", { ticket: view.ticket, decision: "deny" }, { origin }));
    expect(new URL(response.headers.get("location") ?? "").searchParams.get("error")).toBe("access_denied");
  });

  it("validates registrations and throttles them", async () => {
    const bad = await registerClient(ctx, new Request(`${origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://attacker.example/callback"] }),
    }));
    expect(await bad.json()).toMatchObject({ error: "invalid_redirect_uri" });
    for (let index = 0; index < 29; index++) await register();
    const limited = await registerClient(ctx, new Request(`${origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri] }),
    }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
  });
});
