import { beforeEach, describe, expect, it } from "bun:test";
import {
  allowedOrigins,
  guardTransport,
  throttleAnonymous,
  throttleConnection,
} from "./request-guard";
import { clientIpHeader } from "../client-ip";
import { resetThrottleForTest } from "./throttle";

const origins = allowedOrigins(
  "https://files.example.test",
  "http://localhost:3000, not a url",
);
const request = (headers: Record<string, string>) =>
  new Request("https://files.example.test/api/mcp", {
    method: "POST",
    headers,
  });

describe("MCP request guard", () => {
  beforeEach(() => resetThrottleForTest());

  it("accepts MCP clients without an Origin and Nimbus's own pages", () => {
    expect(
      guardTransport(request({ host: "files.example.test" }), origins),
    ).toEqual({ allowed: true });
    expect(
      guardTransport(
        request({ host: "localhost:3000", origin: "http://localhost:3000" }),
        origins,
      ),
    ).toEqual({ allowed: true });
  });

  it("refuses other sites and rebinding host names", () => {
    expect(
      guardTransport(
        request({ host: "files.example.test", origin: "https://evil.example" }),
        origins,
      ),
    ).toMatchObject({ allowed: false, status: 403 });
    expect(
      guardTransport(request({ host: "evil.example" }), origins),
    ).toMatchObject({ allowed: false, status: 421 });
  });

  it("rate limits anonymous requests per address and authenticated ones per connection", () => {
    // The server derives the client address once per request and passes it in this header.
    const anonymous = request({ [clientIpHeader]: "203.0.113.9" });
    for (let index = 0; index < 300; index++)
      expect(throttleAnonymous(anonymous, 0).allowed).toBe(true);
    // The shared limiter refills smoothly: one request every 200 ms at 300 per minute.
    expect(throttleAnonymous(anonymous, 0)).toMatchObject({
      allowed: false,
      status: 429,
      retryAfterSeconds: 1,
    });
    expect(
      throttleAnonymous(request({ [clientIpHeader]: "203.0.113.10" }), 0)
        .allowed,
    ).toBe(true);
    for (let index = 0; index < 600; index++) throttleConnection("grant-1", 0);
    expect(throttleConnection("grant-1", 0).allowed).toBe(false);
    expect(throttleConnection("grant-1", 60_000).allowed).toBe(true);
  });
});
