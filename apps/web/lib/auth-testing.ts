import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  flushAudit,
  resetAuditForTest,
  runWithAuditRequest,
  setAuditSink,
  type RecordedAuditEvent,
} from "@nimbus/api/audit";
import { clientIpHeader } from "../server/client-ip";
import { createTestDatabase } from "../server/db/testing";
import { createNimbusAuth, type NimbusAuthOptions } from "./nimbus-auth";

export const testOrigin = "http://files.example.test";

/** Each harness gets its own client address, because Better Auth's memory rate limits are process-wide. */
let addressCounter = 0;
const nextAddress = () => {
  addressCounter += 1;
  return `198.51.${Math.floor(addressCounter / 250)}.${(addressCounter % 250) + 1}`;
};

const userShape = z.object({ user: z.object({ id: z.string() }) });

export type TestAuth = Awaited<ReturnType<typeof createTestAuth>>;

/**
 * The real Nimbus Better Auth configuration over a migrated in-memory database,
 * with home folders under a temporary data root and audit events collected in memory.
 * Call `close()` in afterEach.
 */
export async function createTestAuth(
  overrides: Partial<Omit<NimbusAuthOptions, "db">> = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nimbus-auth-"));
  const previousRoot = process.env.NIMBUS_DATA_ROOT;
  process.env.NIMBUS_DATA_ROOT = root;
  const { sqlite, db } = createTestDatabase();
  const audit: RecordedAuditEvent[] = [];
  resetAuditForTest();
  setAuditSink(async (events) => {
    audit.push(...events);
  });
  const auth = createNimbusAuth({
    db,
    oidc: { kind: "disabled" },
    sendMail: null,
    origin: { kind: "configured", url: new URL(testOrigin) },
    trustedOrigins: [],
    secret: "test-secret-that-is-at-least-32-characters-long",
    ...overrides,
  });
  const address = nextAddress();

  /** Sends one request through the Better Auth handler, as the Nimbus server would. */
  const request = (
    method: "GET" | "POST",
    endpoint: string,
    {
      body,
      cookie,
      ip = address,
      headers = {},
    }: {
      body?: unknown;
      cookie?: string;
      ip?: string;
      headers?: Record<string, string>;
    } = {},
  ) =>
    runWithAuditRequest({ ip }, () =>
      auth.handler(
        new Request(`${testOrigin}/api/auth${endpoint}`, {
          method,
          headers: {
            origin: testOrigin,
            [clientIpHeader]: ip,
            ...(body !== undefined && { "content-type": "application/json" }),
            ...(cookie !== undefined && { cookie }),
            ...headers,
          },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        }),
      ),
    );

  /** The cookie header a browser would send after `response`. */
  const cookieFrom = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .filter((entry) => !entry.endsWith("="))
      .join("; ");

  const password = "correct horse battery staple";

  /** Signs up through the closed-registration path while no account exists, or creates one as `admin`. */
  const createUser = async (
    email: string,
    { as }: { as?: string } = {},
  ): Promise<{ id: string; cookie: string }> => {
    if (as === undefined) {
      const response = await request("POST", "/sign-up/email", {
        body: { email, password, name: email },
      });
      if (response.status !== 200)
        throw new Error(
          `Test sign-up for ${email} failed with ${response.status}: ${await response.text()}`,
        );
      return {
        id: userShape.parse(await response.json()).user.id,
        cookie: cookieFrom(response),
      };
    }
    const created = await request("POST", "/admin/create-user", {
      cookie: as,
      body: { email, password, name: email, role: "user" },
    });
    if (created.status !== 200)
      throw new Error(
        `Test account creation for ${email} failed with ${created.status}: ${await created.text()}`,
      );
    const { id } = userShape.parse(await created.json()).user;
    return { id, cookie: await signIn(email) };
  };

  const signIn = async (email: string, ip?: string) => {
    const response = await request("POST", "/sign-in/email", {
      body: { email, password },
      ...(ip !== undefined && { ip }),
    });
    if (response.status !== 200)
      throw new Error(
        `Test sign-in for ${email} failed with ${response.status}: ${await response.text()}`,
      );
    return cookieFrom(response);
  };

  return {
    auth,
    db,
    sqlite,
    address,
    password,
    request,
    cookieFrom,
    createUser,
    signIn,
    /** Audit events recorded so far. */
    async auditEvents() {
      await flushAudit();
      return audit;
    },
    async close() {
      resetAuditForTest();
      sqlite.close();
      await rm(root, { recursive: true, force: true });
      if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
      else process.env.NIMBUS_DATA_ROOT = previousRoot;
    },
  };
}
