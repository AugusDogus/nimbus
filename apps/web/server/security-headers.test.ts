import { describe, expect, it } from "bun:test";
import { SecurityHeaders } from "./security-headers";

const production = { development: false, https: true };

describe("SecurityHeaders", () => {
  it("keeps forms on Nimbus unless a document opts out of form-action alone", () => {
    const strict = SecurityHeaders.policy("abc", production);
    expect(strict).toContain("form-action 'self';");
    const open = SecurityHeaders.policy("abc", production, {
      formRedirects: "unrestricted",
    });
    expect(open).not.toContain("form-action");
    // Every other directive stays exactly as strict.
    expect(open.split("; ")).toEqual(
      strict.split("; ").filter((part) => !part.startsWith("form-action")),
    );
  });
  it("allows scripts only with the request nonce in production", () => {
    const policy = SecurityHeaders.policy("abc", production);
    expect(policy).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic';");
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("upgrade-insecure-requests");
    expect(
      SecurityHeaders.policy("abc", { development: true, https: false }),
    ).toContain("'unsafe-eval'");
  });
  it("sends HSTS only for HTTPS deployments", () => {
    expect(
      SecurityHeaders.common(production)["Strict-Transport-Security"],
    ).toBe("max-age=31536000");
    expect(
      SecurityHeaders.common({ development: false, https: false })[
        "Strict-Transport-Security"
      ],
    ).toBeUndefined();
  });
  it("creates distinct 128-bit nonces", () => {
    const nonce = SecurityHeaders.nonce();
    expect(Buffer.from(nonce, "base64")).toHaveLength(16);
    expect(SecurityHeaders.nonce()).not.toBe(nonce);
  });
});
