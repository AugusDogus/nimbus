import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir } from "node:fs/promises";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { McpScope } from "@nimbus/api/mcp-scope";
import { mcpTools } from "@nimbus/api/mcp-tools";
import { appRouter } from "@nimbus/api/routers";
import { openTestDrive, type TestDrive } from "./drive-testing";
import { httpError } from "./http-error";

/**
 * Filesystem failures reach clients as typed errors with plain messages, never as raw system
 * errors naming host paths, through tRPC, MCP tools and the HTTP file routes alike.
 */
describe("filesystem failures seen by clients", () => {
  let drive: TestDrive;
  beforeEach(async () => {
    drive = await openTestDrive();
    await mkdir(drive.absolute("locked"));
    await drive.write("plain.txt", "plain");
    // The server's own permissions refuse writes here, whatever Nimbus allows.
    await chmod(drive.absolute("locked"), 0o500);
  });
  afterEach(async () => {
    await chmod(drive.absolute("locked"), 0o700);
    await drive.close();
  });

  /** One tRPC call over HTTP, as the browser makes it. */
  async function overHttp(procedure: string, input: unknown) {
    const response = await fetchRequestHandler({
      endpoint: "/api/trpc",
      router: appRouter,
      req: new Request(`http://localhost/api/trpc/${procedure}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
      createContext: () => ({
        headers: new Headers(),
        session: { user: { id: "owner" } },
        sessionStillValid: async () => true,
        drive: drive.store,
        preferences: {
          getUserPreferences: async () => null,
          setUserPreferences: async (_id, value) => value,
        },
      }),
    });
    return { status: response.status, body: await response.text() };
  }

  test("tRPC answers a refused write with 403 and no host path", async () => {
    const answer = await overHttp("files.createFolder", {
      path: "locked",
      name: "new",
    });
    expect(answer.status).toBe(403);
    expect(answer.body).toContain("Nimbus service account");
    expect(answer.body).not.toContain(drive.root);
    expect(answer.body).not.toContain("EACCES");
  });

  test("tRPC answers a name too long for the disk with 400", async () => {
    const answer = await overHttp("files.createFolder", {
      name: "é".repeat(200),
    });
    expect(answer.status).toBe(400);
    expect(answer.body).toContain("shorter name");
  });

  test("MCP tools report filesystem failures without host paths", async () => {
    const tool = mcpTools.find((entry) => entry.name === "create_folder");
    if (!tool) throw new Error("The create_folder tool is missing.");
    const result = await tool.call(
      {
        userId: "owner",
        scopes: McpScope.all,
        drive: drive.store,
        preferences: {
          getUserPreferences: async () => null,
          setUserPreferences: async (_id, value) => value,
        },
        origin: "https://files.example.test",
        downloadLink: async () => ({ url: "", expiresAt: 0 }),
      },
      { parentPath: "locked", name: "new" },
    );
    expect(result).toMatchObject({ ok: false });
    const message = result.ok ? "" : result.message;
    expect(message).toContain("Nimbus service account");
    expect(message).not.toContain(drive.root);
  });

  test("file routes answer filesystem failures with their status and no host path", async () => {
    const failure = (code: string) =>
      Object.assign(
        new Error(`${code}: failed, open '${drive.absolute("x/y")}'`),
        { code, syscall: "open", path: drive.absolute("x/y") },
      );
    for (const [code, status] of [
      ["EACCES", 403],
      ["ENOTDIR", 404],
      ["ENOSPC", 503],
      ["ENAMETOOLONG", 400],
    ] as const) {
      const response = httpError(failure(code));
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain(drive.root);
    }
  });
});
