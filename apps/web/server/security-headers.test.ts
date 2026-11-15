import { describe, expect, it } from "bun:test";
import { SecurityHeaders } from "./security-headers";

const production = { development: false, https: true };

describe("SecurityHeaders", () => {
  it("applies the document policy to pages only", () => {
    for (const path of ["/", "/login", "/browse/a%20b", "/s/token", "/settings/admin/audit", "/apis-folder"])
      expect(SecurityHeaders.isDocument(path)).toBe(true);
    for (const path of ["/api/files/download", "/api", "/dav/x", "/_next/static/a.js", "/icon.svg"])
      expect(SecurityHeaders.isDocument(path)).toBe(false);
  });
  it("allows scripts only with the request nonce in production", () => {
    const policy = SecurityHeaders.policy("abc", production);
    expect(policy).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic';");
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("upgrade-insecure-requests");
    expect(SecurityHeaders.policy("abc", { development: true, https: false })).toContain("'unsafe-eval'");
  });
  it("sends HSTS only for HTTPS deployments", () => {
    expect(SecurityHeaders.common(production)["Strict-Transport-Security"]).toBe("max-age=31536000");
    expect(SecurityHeaders.common({ development: false, https: false })["Strict-Transport-Security"]).toBeUndefined();
  });
  it("creates distinct 128-bit nonces", () => {
    const nonce = SecurityHeaders.nonce();
    expect(Buffer.from(nonce, "base64")).toHaveLength(16);
    expect(SecurityHeaders.nonce()).not.toBe(nonce);
  });
});
