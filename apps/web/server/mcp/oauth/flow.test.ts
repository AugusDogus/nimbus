import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import type { Database as SQLite } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  flushAudit,
  resetAuditForTest,
  setAuditSink,
  type RecordedAuditEvent,
} from "@nimbus/api/audit";
import * as schema from "../../db/schema";
import { createTestDatabase } from "../../db/testing";
import { resetThrottleForTest } from "../throttle";
import { decideConsent, handleAuthorize, loadConsent } from "./authorization";
import { clientIpHeader } from "../../client-ip";
import { MAX_UNUSED_CLIENTS, registerClient } from "./clients";
import { listConnections, revokeConnection } from "./connections";
import type { BrowserSession, OAuthContext } from "./context";
import { authenticateBearer, handleRevoke, handleToken } from "./tokens";

// bun-types declares asymmetric matchers as returning any; typing them unknown keeps any out of the assertions.
const containing = (text: string): unknown => expect.stringContaining(text);

const origin = "https://files.example.test";
const redirectUri = "http://127.0.0.1:33418/callback";

describe("MCP OAuth flow", () => {
  let client: SQLite;
  let ctx: OAuthContext;
  let now: number;
  let session: BrowserSession | null;

  const post = (
    path: string,
    body: Record<string, string>,
    headers: Record<string, string> = {},
  ) =>
    new Request(`${origin}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams(body),
    });

  const register = async (metadata: Record<string, unknown> = {}) => {
    const response = await registerClient(
      ctx,
      new Request(`${origin}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Claude Code",
          redirect_uris: [redirectUri],
          ...metadata,
        }),
      }),
    );
    expect(response.status).toBe(201);
    return z.object({ client_id: z.string() }).parse(await response.json())
      .client_id;
  };

  const pkce = () => {
    const verifier = randomBytes(32).toString("base64url");
    return {
      verifier,
      challenge: createHash("sha256").update(verifier).digest("base64url"),
    };
  };

  const authorizeParams = (
    clientId: string,
    challenge: string,
    extra: Record<string, string> = {},
  ) =>
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
  const approve = async (
    clientId: string,
    challenge: string,
    form: Record<string, string> = { allow_write: "on", allow_share: "on" },
  ) => {
    const view = await loadConsent(
      ctx,
      authorizeParams(clientId, challenge),
      new Headers(),
    );
    if (view.kind !== "ready")
      throw new Error(`Expected a consent form, got ${view.kind}`);
    const response = await decideConsent(
      ctx,
      post(
        "/oauth/consent",
        { ticket: view.ticket, decision: "approve", ...form },
        { origin },
      ),
    );
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("state")).toBe("client-state");
    expect(location.searchParams.get("iss")).toBe(origin);
    return location.searchParams.get("code") ?? "";
  };

  const exchange = async (clientId: string, code: string, verifier: string) =>
    handleToken(
      ctx,
      post("/oauth/token", {
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    );

  const connect = async (form?: Record<string, string>) => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const response = await exchange(
      clientId,
      await approve(clientId, challenge, form),
      verifier,
    );
    expect(response.status).toBe(200);
    const tokens = z
      .object({
        access_token: z.string(),
        refresh_token: z.string(),
        scope: z.string(),
      })
      .parse(await response.json());
    return { clientId, ...tokens };
  };

  const bearer = (token: string) =>
    authenticateBearer(
      ctx,
      new Request(`${origin}/api/mcp`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );

  beforeEach(async () => {
    const { sqlite, db } = createTestDatabase();
    client = sqlite;
    client.run(
      "INSERT INTO user (id, name, email, role) VALUES ('owner', 'Owner', 'owner@example.test', 'admin')",
    );
    now = 1_800_000_000_000;
    session = { userId: "owner", sessionId: "session-1", impersonatedBy: null };
    ctx = {
      db,
      origin,
      secret: "s".repeat(32),
      now: () => now,
      getSession: async () => session,
    };
    resetThrottleForTest();
  });
  afterEach(() => {
    client.close();
  });

  it("sends signed-out users to sign-in and back to consent", async () => {
    const clientId = await register();
    session = null;
    const response = await handleAuthorize(
      ctx,
      new Request(
        `${origin}/oauth/authorize?${authorizeParams(clientId, pkce().challenge)}`,
      ),
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "", origin);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("callbackURL")).toStartWith(
      "/oauth/consent?",
    );
  });

  it("accepts only the exact registered loopback redirect URI", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const view = await loadConsent(
      ctx,
      authorizeParams(clientId, challenge),
      new Headers(),
    );
    if (view.kind !== "ready")
      throw new Error(`Expected a consent form, got ${view.kind}`);
    const response = await decideConsent(
      ctx,
      post(
        "/oauth/consent",
        { ticket: view.ticket, decision: "approve" },
        { origin },
      ),
    );
    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(redirectUri);
    expect(
      (
        await exchange(
          clientId,
          location.searchParams.get("code") ?? "",
          verifier,
        )
      ).status,
    ).toBe(200);
    for (const other of [
      "http://localhost:33418/callback",
      "http://localhost:9999/callback",
    ])
      expect(
        await loadConsent(
          ctx,
          authorizeParams(clientId, challenge, { redirect_uri: other }),
          new Headers(),
        ),
      ).toMatchObject({ kind: "invalid" });
  });

  it("never redirects an unregistered redirect URI, even for errors", async () => {
    const clientId = await register();
    const params = authorizeParams(clientId, pkce().challenge, {
      redirect_uri: "https://attacker.example/callback",
    });
    const response = await handleAuthorize(
      ctx,
      new Request(`${origin}/oauth/authorize?${params}`),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain("will not send you there");
  });

  it("issues tokens that authenticate MCP requests with the approved scopes", async () => {
    const tokens = await connect();
    expect(tokens.access_token).toStartWith("nimbus_mcp_access_");
    expect(tokens.scope).toBe("files:read files:write files:share");
    expect(await bearer(tokens.access_token)).toMatchObject({
      kind: "authenticated",
      userId: "owner",
      scopes: ["files:read", "files:write", "files:share"],
    });
    expect(await listConnections(ctx.db, "owner")).toMatchObject([
      { clientName: "Claude Code", lastUsedAt: now },
    ]);
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
    expect(await wrong.json()).toMatchObject({
      error: "invalid_grant",
      error_description: containing("PKCE"),
    });
  });

  it("revokes the connection when its own client replays a used code", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const code = await approve(clientId, challenge);
    const first = z
      .object({ access_token: z.string() })
      .parse(await (await exchange(clientId, code, verifier)).json());
    expect((await exchange(clientId, code, verifier)).status).toBe(400);
    expect(await bearer(first.access_token)).toMatchObject({
      kind: "rejected",
    });
  });

  it("rotates refresh tokens and treats reuse after the grace window as theft", async () => {
    const tokens = await connect();
    const refresh = (token: string) =>
      handleToken(
        ctx,
        post("/oauth/token", {
          grant_type: "refresh_token",
          client_id: tokens.clientId,
          refresh_token: token,
        }),
      );
    const rotated = await refresh(tokens.refresh_token);
    expect(rotated.status).toBe(200);
    const next = z
      .object({ access_token: z.string(), refresh_token: z.string() })
      .parse(await rotated.json());
    expect(await bearer(next.access_token)).toMatchObject({
      kind: "authenticated",
    });
    now += 60_000;
    expect(await (await refresh(tokens.refresh_token)).json()).toMatchObject({
      error_description: containing("revoked"),
    });
    expect(await bearer(next.access_token)).toMatchObject({ kind: "rejected" });
  });

  const pair = z.object({
    access_token: z.string(),
    refresh_token: z.string(),
  });
  const refreshWith = (clientId: string, token: string) =>
    handleToken(
      ctx,
      post("/oauth/token", {
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: token,
      }),
    );

  it("lets a client retry a refresh whose answer it never received", async () => {
    const tokens = await connect();
    const lost = pair.parse(
      await (await refreshWith(tokens.clientId, tokens.refresh_token)).json(),
    );
    now += 10_000;
    const retried = await refreshWith(tokens.clientId, tokens.refresh_token);
    expect(retried.status).toBe(200);
    const fresh = pair.parse(await retried.json());
    expect(await bearer(fresh.access_token)).toMatchObject({
      kind: "authenticated",
    });
    // The answer the client never received no longer works.
    expect(await bearer(lost.access_token)).toMatchObject({ kind: "rejected" });
    expect(
      (await refreshWith(tokens.clientId, lost.refresh_token)).status,
    ).toBe(400);
    expect(
      (await refreshWith(tokens.clientId, fresh.refresh_token)).status,
    ).toBe(200);
  });

  it("two refreshes racing with one token leave exactly one working pair", async () => {
    const tokens = await connect();
    const responses = await Promise.all([
      refreshWith(tokens.clientId, tokens.refresh_token),
      refreshWith(tokens.clientId, tokens.refresh_token),
    ]);
    // The loser is treated as a retry within the grace window, not refused: it gets the
    // live pair and the winner's unused pair is retired, so a thief who wins the race
    // without using the tokens yet keeps nothing.
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const pairs = await Promise.all(
      responses.map(async (response) =>
        response.status === 200 ? pair.parse(await response.json()) : null,
      ),
    );
    const working = [];
    for (const issued of pairs)
      if (
        issued &&
        (await bearer(issued.access_token)).kind === "authenticated"
      )
        working.push(issued);
    expect(working).toHaveLength(1);
    const [survivor] = working;
    if (!survivor) throw new Error("Expected one working token pair.");
    // The other pair is gone, not still usable by whoever won the race.
    for (const issued of pairs)
      if (issued && issued !== survivor)
        expect(
          (await refreshWith(tokens.clientId, issued.refresh_token)).status,
        ).toBe(400);
  });

  it("disconnects the client when a refresh token is replayed after its successor was used", async () => {
    for (const useSuccessor of ["access", "refresh"] as const) {
      const tokens = await connect();
      // Someone else holds the refresh token and rotates it first.
      const stolen = pair.parse(
        await (await refreshWith(tokens.clientId, tokens.refresh_token)).json(),
      );
      if (useSuccessor === "access")
        expect(await bearer(stolen.access_token)).toMatchObject({
          kind: "authenticated",
        });
      else
        expect(
          (await refreshWith(tokens.clientId, stolen.refresh_token)).status,
        ).toBe(200);
      now += 10_000;
      const replayed = await refreshWith(tokens.clientId, tokens.refresh_token);
      expect(await replayed.json()).toMatchObject({
        error: "invalid_grant",
        error_description: containing("revoked"),
      });
      expect(await bearer(stolen.access_token)).toMatchObject({
        kind: "rejected",
      });
      expect(
        (await refreshWith(tokens.clientId, stolen.refresh_token)).status,
      ).toBe(400);
    }
  });

  it("an administrator signed in as someone else cannot connect AI clients for them", async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const view = await loadConsent(
      ctx,
      authorizeParams(clientId, challenge),
      new Headers(),
    );
    if (view.kind !== "ready")
      throw new Error(`Expected a consent form, got ${view.kind}`);
    session = {
      userId: "owner",
      sessionId: "session-1",
      impersonatedBy: "admin-1",
    };
    expect(
      await loadConsent(
        ctx,
        authorizeParams(clientId, challenge),
        new Headers(),
      ),
    ).toMatchObject({ kind: "invalid", message: containing("administrator") });
    const decided = await decideConsent(
      ctx,
      post(
        "/oauth/consent",
        { ticket: view.ticket, decision: "approve" },
        { origin },
      ),
    );
    expect(decided.status).toBe(403);
    expect(await listConnections(ctx.db, "owner")).toEqual([]);
  });

  it("refuses to refresh tokens for a different resource", async () => {
    const tokens = await connect();
    const response = await handleToken(
      ctx,
      post("/oauth/token", {
        grant_type: "refresh_token",
        client_id: tokens.clientId,
        refresh_token: tokens.refresh_token,
        resource: "https://other.example/mcp",
      }),
    );
    expect(await response.json()).toMatchObject({ error: "invalid_target" });
  });

  it("rejects expired access tokens", async () => {
    const tokens = await connect();
    now += 60 * 60 * 1000;
    expect(await bearer(tokens.access_token)).toMatchObject({
      kind: "rejected",
      message: containing("expired"),
    });
  });

  it("cuts off a disabled account immediately", async () => {
    client.run(
      "INSERT INTO user (id, name, email) VALUES ('member', 'Member', 'member@example.test')",
    );
    session = {
      userId: "member",
      sessionId: "session-2",
      impersonatedBy: null,
    };
    const tokens = await connect();
    await ctx.db
      .update(schema.user)
      .set({ banned: true })
      .where(eq(schema.user.id, "member"));
    expect(await bearer(tokens.access_token)).toMatchObject({
      kind: "rejected",
      message: containing("disabled"),
    });
  });

  it("lets the user revoke a connection from Settings and a client revoke its own token", async () => {
    const first = await connect();
    const [connection] = await listConnections(ctx.db, "owner");
    if (!connection) throw new Error("Expected a connection");
    expect(
      await revokeConnection(ctx.db, "someone-else", connection.id, now),
    ).toBe(false);
    expect(await revokeConnection(ctx.db, "owner", connection.id, now)).toBe(
      true,
    );
    expect(await bearer(first.access_token)).toMatchObject({
      kind: "rejected",
      message: containing("revoked"),
    });
    const second = await connect();
    expect(
      (
        await handleRevoke(
          ctx,
          post("/oauth/revoke", {
            token: second.refresh_token,
            client_id: second.clientId,
          }),
        )
      ).status,
    ).toBe(200);
    expect(await bearer(second.access_token)).toMatchObject({
      kind: "rejected",
    });
    expect(await listConnections(ctx.db, "owner")).toEqual([]);
  });

  it("records approvals, refused token requests, and disconnections in the audit log", async () => {
    resetAuditForTest();
    const events: RecordedAuditEvent[] = [];
    setAuditSink(async (batch) => void events.push(...batch));
    try {
      const first = await connect();
      expect(
        (
          await handleToken(
            ctx,
            post("/oauth/token", {
              grant_type: "refresh_token",
              client_id: first.clientId,
              refresh_token: "not-a-token",
            }),
          )
        ).status,
      ).toBe(400);
      const [connection] = await listConnections(ctx.db, "owner");
      if (!connection) throw new Error("Expected a connection");
      await revokeConnection(ctx.db, "owner", connection.id, now);
      await flushAudit();
      expect(
        events.map(({ action, actor, target }) => ({
          action,
          actor: actor.type,
          target: target?.type,
        })),
      ).toEqual([
        { action: "mcp.client_approved", actor: "user", target: "mcp_client" },
        {
          action: "mcp.token_failed",
          actor: "anonymous",
          target: "mcp_client",
        },
        {
          action: "mcp.client_disconnected",
          actor: "user",
          target: "mcp_client",
        },
      ]);
      expect(JSON.stringify(events)).not.toContain(first.refresh_token);
    } finally {
      resetAuditForTest();
    }
  });

  it("refuses consent decisions from other origins or sessions", async () => {
    const clientId = await register();
    const view = await loadConsent(
      ctx,
      authorizeParams(clientId, pkce().challenge),
      new Headers(),
    );
    if (view.kind !== "ready") throw new Error("Expected a consent form");
    expect(
      (
        await decideConsent(
          ctx,
          post(
            "/oauth/consent",
            { ticket: view.ticket, decision: "approve" },
            { origin: "https://evil.example" },
          ),
        )
      ).status,
    ).toBe(403);
    session = {
      userId: "owner",
      sessionId: "other-session",
      impersonatedBy: null,
    };
    expect(
      (
        await decideConsent(
          ctx,
          post(
            "/oauth/consent",
            { ticket: view.ticket, decision: "approve" },
            { origin },
          ),
        )
      ).status,
    ).toBe(400);
  });

  it("reports denial to the client", async () => {
    const clientId = await register();
    const view = await loadConsent(
      ctx,
      authorizeParams(clientId, pkce().challenge),
      new Headers(),
    );
    if (view.kind !== "ready") throw new Error("Expected a consent form");
    const response = await decideConsent(
      ctx,
      post(
        "/oauth/consent",
        { ticket: view.ticket, decision: "deny" },
        { origin },
      ),
    );
    expect(
      new URL(response.headers.get("location") ?? "").searchParams.get("error"),
    ).toBe("access_denied");
  });

  it("returns the code to a desktop app's custom-scheme redirect URI", async () => {
    const appUri = "cursor://anysphere.cursor-retrieval/oauth/callback";
    const clientId = await register({ redirect_uris: [appUri] });
    const view = await loadConsent(
      ctx,
      authorizeParams(clientId, pkce().challenge, { redirect_uri: appUri }),
      new Headers(),
    );
    if (view.kind !== "ready") throw new Error("Expected a consent form");
    expect(view.redirectTarget).toBe("anysphere.cursor-retrieval");
    const response = await decideConsent(
      ctx,
      post(
        "/oauth/consent",
        { ticket: view.ticket, decision: "approve" },
        { origin },
      ),
    );
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.protocol}//${location.host}${location.pathname}`).toBe(
      appUri,
    );
    expect(location.searchParams.get("code")).toStartWith("nimbus_mcp_code_");
    expect(location.searchParams.get("state")).toBe("client-state");
    expect(location.searchParams.get("iss")).toBe(origin);
  });

  const registerFrom = (address: string) =>
    registerClient(
      ctx,
      new Request(`${origin}/oauth/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [clientIpHeader]: address,
        },
        body: JSON.stringify({ redirect_uris: [redirectUri] }),
      }),
    );

  it("a few addresses at their own limits cannot block registration for everyone", async () => {
    for (let network = 0; network < 12; network++)
      for (let index = 0; index < 30; index++)
        expect((await registerFrom(`10.0.${network}.1`)).status).toBe(201);
    expect((await registerFrom("192.0.2.10")).status).toBe(201);
  });

  it("limits registration per network, not only per address", async () => {
    const statuses: number[] = [];
    for (let host = 1; host <= 4; host++)
      for (let index = 0; index < 30; index++)
        statuses.push((await registerFrom(`10.1.0.${host}`)).status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(60);
    expect((await registerFrom("10.1.1.1")).status).toBe(201);
  });

  it("keeps the newest unused registrations when storage is full", async () => {
    await ctx.db.insert(schema.mcpClients).values(
      Array.from({ length: MAX_UNUSED_CLIENTS }, (_, index) => ({
        clientId: `old-${index}`,
        clientName: "Old",
        redirectUrisJson: JSON.stringify([redirectUri]),
        tokenEndpointAuthMethod: "none" as const,
        scope: "files:read",
        createdAt: now - 1000 + index,
      })),
    );
    const response = await registerFrom("192.0.2.20");
    expect(response.status).toBe(201);
    const { client_id } = z
      .object({ client_id: z.string() })
      .parse(await response.json());
    const stored = await ctx.db
      .select({ clientId: schema.mcpClients.clientId })
      .from(schema.mcpClients);
    expect(stored).toHaveLength(MAX_UNUSED_CLIENTS);
    expect(stored.map((row) => row.clientId)).toContain(client_id);
    expect(stored.map((row) => row.clientId)).not.toContain("old-0");
  });

  it("validates registrations and throttles them", async () => {
    const bad = await registerClient(
      ctx,
      new Request(`${origin}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["http://attacker.example/callback"],
        }),
      }),
    );
    expect(await bad.json()).toMatchObject({ error: "invalid_redirect_uri" });
    for (let index = 0; index < 29; index++) await register();
    const limited = await registerClient(
      ctx,
      new Request(`${origin}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [redirectUri] }),
      }),
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
  });
});
