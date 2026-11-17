import { describe, expect, test } from "bun:test";
import { EventStreams } from "./event-streams";

const request = (path: string, accept = "text/event-stream") =>
  new Request(`http://localhost${path}`, { headers: { Accept: accept } });
const stream = () =>
  new Response("data: {}\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  });
const json = () => Response.json({ error: "No procedure found" });

describe("EventStreams", () => {
  test("only endpoints that stream events may ask to", () => {
    expect(EventStreams.requested(request("/api/trpc/files.onChange"))).toBe(
      true,
    );
    expect(
      EventStreams.requested(
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
      expect(EventStreams.requested(request(path)), path).toBe(false);
    expect(
      EventStreams.requested(request("/api/trpc/files.onChange", "*/*")),
    ).toBe(false);
  });

  test("the idle timeout lifts only for an answer that is an event stream", () => {
    const subscription = request("/api/trpc/files.onChange");
    expect(EventStreams.untimed(subscription, stream())).toBe(true);
    // A query, a missing procedure or a refused request asking for a stream keeps the timeout.
    expect(EventStreams.untimed(request("/api/trpc/files.list"), json())).toBe(
      false,
    );
    expect(EventStreams.untimed(request("/api/trpc/nothing"), json())).toBe(
      false,
    );
    expect(EventStreams.untimed(request("/api/upload/x"), stream())).toBe(
      false,
    );
  });
});
