import { describe, expect, test } from "bun:test";
import { SameSiteRedirect } from "./same-site-redirect";

describe("SameSiteRedirect", () => {
  test("sends a path on this site as a relative Location", () => {
    const response = SameSiteRedirect.response(
      "/login?callbackURL=%2Fbrowse%2FDocuments#top",
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "/login?callbackURL=%2Fbrowse%2FDocuments#top",
    );
  });

  test.each([
    "//evil.example/start",
    "/\\evil.example/start",
    "https://evil.example/start",
    "http://internal:3000/start",
    "javascript:alert(1)",
    "data:text/html,hi",
    "login",
    "/\t/evil.example",
    "",
  ])("refuses to follow %p", (location) => {
    expect(SameSiteRedirect.path(location)).toBeNull();
    expect(() => SameSiteRedirect.response(location)).toThrow(
      "only paths on this site are followed",
    );
  });
});
