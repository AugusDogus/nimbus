import { describe, expect, it } from "bun:test";
import { CallbackUrl } from "./callback-url";

describe("CallbackUrl", () => {
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
