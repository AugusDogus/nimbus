import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { expect, type Page } from "@playwright/test";
import { z } from "zod";
import { adminEmail, e2eOrigin, password, test } from "./helpers";

/** A loopback redirect listener, as CLI clients run during authorization (RFC 8252). */
async function loopbackCallback() {
  let receive: (url: URL) => void = () => {};
  const received = new Promise<URL>((resolve) => (receive = resolve));
  const server = createServer((request, response) => {
    receive(new URL(request.url ?? "/", "http://127.0.0.1"));
    response.end("Connected. You can close this window.");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The callback listener has no port.");
  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
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

const endpoint = () => new URL(`${e2eOrigin}/api/mcp`);

/** Run discovery and registration, approve in the browser, and return a connected client. */
async function connect(page: Page, name: string, approve: (page: Page) => Promise<void>) {
  const callback = await loopbackCallback();
  try {
    const auth = new TestAuthProvider(name, callback.redirectUri);
    const first = new StreamableHTTPClientTransport(endpoint(), { authProvider: auth });
    await expect(new Client({ name, version: "1.0.0" }).connect(first)).rejects.toBeInstanceOf(UnauthorizedError);
    const authorizationUrl = auth.authorizationUrl;
    if (!authorizationUrl) throw new Error("The client was not sent to Nimbus to authorize.");
    expect(authorizationUrl.origin).toBe(e2eOrigin);
    await page.goto(authorizationUrl.href);
    await approve(page);
    const returned = await callback.received;
    expect(returned.searchParams.get("iss")).toBe(e2eOrigin);
    await expect(page.getByText("Connected. You can close this window.")).toBeVisible();
    await first.finishAuth(returned.searchParams);
    const client = new Client({ name, version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(endpoint(), { authProvider: auth }));
    return client;
  } finally {
    await callback.close();
  }
}

const consent = (page: Page) => page.getByRole("button", { name: "Connect", exact: true });

const structured = (result: unknown) =>
  z.object({ structuredContent: z.record(z.string(), z.unknown()) }).parse(result).structuredContent;
const errorText = (result: unknown) => {
  const parsed = z.object({ isError: z.literal(true), content: z.array(z.object({ text: z.string() })) }).parse(result);
  return parsed.content.map((item) => item.text).join("\n");
};

test("an MCP client connects through OAuth, works with files, and is cut off when disconnected", async ({ page, isMobile }) => {
  test.skip(isMobile, "Protocol flow; the consent and settings layouts are exercised on desktop.");
  const name = `E2E agent ${randomUUID().slice(0, 8)}`;
  const client = await connect(page, name, async (current) => {
    await expect(current.getByRole("heading", { name: `Connect ${name}?` })).toBeVisible();
    await expect(current.getByText(adminEmail)).toBeVisible();
    await consent(current).click();
  });

  const tools = (await client.listTools()).tools;
  expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["list_folder", "write_text", "create_public_link"]));
  expect(tools.find((tool) => tool.name === "list_folder")?.annotations).toMatchObject({ readOnlyHint: true });
  expect(tools.find((tool) => tool.name === "move_to_trash")?.annotations).toMatchObject({ destructiveHint: true });

  const root = structured(await client.callTool({ name: "list_folder", arguments: { path: "" } }));
  expect(JSON.stringify(root)).toContain("alpha.txt");
  expect(JSON.stringify(root)).not.toContain(".nimbus");

  const file = `mcp-${randomUUID()}.txt`;
  expect(structured(await client.callTool({ name: "write_text", arguments: { path: file, content: "written by an agent" } }))).toMatchObject({ outcome: "created" });
  expect(errorText(await client.callTool({ name: "write_text", arguments: { path: file, content: "again" } }))).toContain("already exists");
  expect(structured(await client.callTool({ name: "read_text", arguments: { path: file } }))).toMatchObject({ content: { kind: "text", text: "written by an agent" } });

  const link = z.object({ url: z.string() }).parse(structured(await client.callTool({ name: "get_download_link", arguments: { path: file } })));
  const download = await page.request.get(link.url);
  expect(download.status()).toBe(200);
  expect(await download.text()).toBe("written by an agent");

  await page.goto("/settings/mcp");
  await expect(page.getByRole("textbox", { name: "Server address", exact: true })).toHaveValue(`${e2eOrigin}/api/mcp`);
  const row = page.getByRole("listitem").filter({ hasText: name });
  await expect(row).toContainText("Last used");
  await row.getByRole("button", { name: "Disconnect", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  // The open dialog hides the list from the accessibility tree, so wait for it to close first.
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("listitem").filter({ hasText: name })).toHaveCount(0);

  expect((await page.request.get(link.url)).status()).toBe(403);
  await expect(client.callTool({ name: "list_folder", arguments: { path: "" } })).rejects.toThrow();
});

test("a signed-out user signs in, then connects a client with view access only", async ({ browser, isMobile }) => {
  test.skip(isMobile, "Protocol flow; covered on desktop.");
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  const client = await connect(page, `Viewer ${randomUUID().slice(0, 8)}`, async (current) => {
    await expect(current).toHaveURL(/\/login\?callbackURL=/);
    await current.getByLabel("Email", { exact: true }).fill(adminEmail);
    await current.getByLabel("Password", { exact: true }).fill(password);
    await current.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(consent(current)).toBeVisible();
    await current.getByRole("checkbox", { name: /Change your files/ }).uncheck();
    await current.getByRole("checkbox", { name: /Manage sharing/ }).uncheck();
    await consent(current).click();
  });
  expect(structured(await client.callTool({ name: "list_folder", arguments: { path: "docs" } }))).toMatchObject({ entries: [{ name: "readme.md" }] });
  // Nimbus answers 403 insufficient_scope; the SDK then asks the user to authorize again.
  await expect(client.callTool({ name: "move_to_trash", arguments: { path: "alpha.txt" } })).rejects.toBeInstanceOf(UnauthorizedError);
  expect(JSON.stringify(structured(await client.callTool({ name: "list_folder", arguments: { path: "" } })))).toContain("alpha.txt");
  await context.close();
});
