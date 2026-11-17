import { describe, expect, it } from "bun:test";
import { LinkUnlock } from "./link-unlock";

const reply = (status: number, body: string, headers: HeadersInit = {}) =>
  new Response(body, { status, headers });

describe("LinkUnlock.failure", () => {
  it("says how long to wait when attempts are throttled, not that the password is wrong", async () => {
    expect(
      await LinkUnlock.failure(
        reply(429, '{"error":"Too many wrong passwords."}', {
          "Retry-After": "20",
        }),
        "fallback",
      ),
    ).toBe(
      "Too many password attempts on this link. Wait 20 seconds, then try again. Your password was not checked.",
    );
    expect(
      await LinkUnlock.failure(
        reply(429, "", { "Retry-After": "600" }),
        "fallback",
      ),
    ).toContain("Wait 10 minutes");
    expect(
      await LinkUnlock.failure(reply(429, "", { "Retry-After": "1" }), "x"),
    ).toContain("Wait 1 second,");
  });

  it("shows the server's reason, or the fallback for a reply that is not JSON", async () => {
    expect(
      await LinkUnlock.failure(
        reply(401, '{"error":"That password is incorrect."}'),
        "fallback",
      ),
    ).toBe("That password is incorrect.");
    expect(
      await LinkUnlock.failure(
        reply(502, "<html>Bad gateway</html>"),
        "fallback",
      ),
    ).toBe("fallback");
  });
});
