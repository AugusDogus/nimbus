import { describe, expect, test } from "bun:test";
import { EventStreams } from "./event-streams";

const request = (path: string, accept = "text/event-stream") =>
  new Request(`http://localhost${path}`, { headers: { Accept: accept } });

describe("EventStreams.untimed", () => {
  test("only endpoints that stream events may run without the idle timeout", () => {
    expect(EventStreams.untimed(request("/api/trpc/files.onChange"))).toBe(
      true,
    );
    expect(
      EventStreams.untimed(
        request("/api/mcp", "application/json, text/event-stream"),
      ),
    ).toBe(true);
    for (const path of [
      "/",
      "/login",
      "/api/files/download",
      "/api/upload/abc",
      "/dav/file.txt",
      "/api/mcp/download",
    ])
      expect(EventStreams.untimed(request(path)), path).toBe(false);
    expect(
      EventStreams.untimed(request("/api/trpc/files.onChange", "*/*")),
    ).toBe(false);
  });
});
