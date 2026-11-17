import { describe, expect, it } from "bun:test";
import { CallbackUrl } from "./callback-url";

describe("CallbackUrl", () => {
  it("builds the sign-in address that returns to a page", () => {
    expect(CallbackUrl.signInPath("/browse/a%20b?x=1#top")).toBe(
      "/login?callbackURL=%2Fbrowse%2Fa%2520b%3Fx%3D1%23top",
    );
    expect(CallbackUrl.signInPath("/")).toBe("/login");
    expect(CallbackUrl.signInPath("//evil.example")).toBe("/login");
  });
  it("keeps same-origin paths", () => {
    expect(CallbackUrl.parse("/oauth/consent?client_id=a&state=b")).toBe(
      "/oauth/consent?client_id=a&state=b",
    );
  });
  it("falls back to the drive for anything that could leave Nimbus", () => {
    for (const value of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "/ok\nLocation",
      "",
      undefined,
      ["/a"],
    ])
      expect(CallbackUrl.parse(value)).toBe("/");
  });
});
