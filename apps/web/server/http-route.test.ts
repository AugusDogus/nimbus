import { describe, expect, test } from "bun:test";
import { pathSegments, route, type Route } from "./http-route";

const find = (routes: Route[], pathname: string) => {
  const segments = pathSegments(pathname);
  if (!segments) return null;
  for (const candidate of routes) {
    const handler = candidate.match(segments);
    if (handler) return handler;
  }
  return null;
};

const echo = (name: string) => ({
  GET: async (_request: Request, context: { params: Promise<unknown> }) =>
    Response.json({ name, params: await context.params }),
});

const routes = [
  route("/api/file-request/upload/*?", () => ({}), echo("upload")),
  route("/api/file-request/:token", ([token]) => ({ token }), echo("token")),
  route("/api/auth/*", ([rest]) => ({ rest }), echo("auth")),
  route("/api/health", () => ({}), {
    GET: () => new Response("ok"),
    HEAD: () => new Response(null),
  }),
];

const call = async (pathname: string, method = "GET") => {
  const handler = find(routes, pathname);
  return handler
    ? handler(new Request(`http://localhost${pathname}`, { method }))
    : null;
};

describe("route", () => {
  test("decodes parameters once", async () => {
    const response = await call("/api/file-request/a%2Fb%20c%25");
    expect(await response?.json()).toEqual({
      name: "token",
      params: { token: "a/b c%" },
    });
  });

  test("matches literal routes listed before a parameter route", async () => {
    expect(await (await call("/api/file-request/upload"))?.json()).toEqual({
      name: "upload",
      params: {},
    });
    expect(
      await (await call("/api/file-request/upload/abc/def"))?.json(),
    ).toEqual({ name: "upload", params: {} });
  });

  test("requires at least one segment for a rest pattern", async () => {
    expect(await call("/api/auth")).toBeNull();
    expect(await (await call("/api/auth/get-session/x"))?.json()).toEqual({
      name: "auth",
      params: { rest: "get-session/x" },
    });
  });

  test("matches whole paths only", async () => {
    expect(await call("/api/health/extra")).toBeNull();
    expect(await call("/api/healthy")).toBeNull();
    expect(await call("/api/health/")).toBeNull();
  });

  test("refuses other methods with the allowed list", async () => {
    const response = await call("/api/health", "POST");
    expect(response?.status).toBe(405);
    expect(response?.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });

  test("answers OPTIONS for routes that do not handle it", async () => {
    const response = await call("/api/health", "OPTIONS");
    expect(response?.status).toBe(204);
    expect(response?.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });

  test("matches nothing for malformed percent-encoding", async () => {
    expect(pathSegments("/api/file-request/%E0%A4%A")).toBeNull();
  });
});
