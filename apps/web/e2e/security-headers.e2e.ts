import { expect } from "@playwright/test";
import { test } from "./helpers";

test("pages are served with an enforced Content-Security-Policy and hardening headers", async ({ page, request }) => {
  const response = await request.get("/login");
  const headers = response.headers();
  const policy = headers["content-security-policy"] ?? "";
  expect(policy).toContain("default-src 'self'");
  expect(policy).toMatch(/script-src [^;]*'nonce-[A-Za-z0-9+/=_-]+'/);
  expect(policy).toContain("frame-ancestors 'none'");
  expect(policy).toContain("object-src 'none'");
  expect(policy).toContain("base-uri 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["permissions-policy"]).toContain("camera=()");
  expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  // The e2e server runs over plain HTTP, where browsers ignore HSTS and Nimbus omits it.
  expect(headers["strict-transport-security"]).toBeUndefined();
  const second = (await request.get("/login")).headers()["content-security-policy"];
  expect(second).not.toBe(policy);

  const session = (await page.context().cookies()).find((cookie) => cookie.name.endsWith("better-auth.session_token"));
  expect(session).toMatchObject({ httpOnly: true, sameSite: "Lax" });

  const violations: string[] = [];
  await page.exposeFunction("reportViolation", (text: string) => violations.push(text));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      void (window as unknown as { reportViolation: (text: string) => void }).reportViolation(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  for (const path of ["/", "/settings/account", "/settings/appearance", "/settings/admin", "/settings/admin/audit", "/shared", "/trash"]) {
    // The live update stream keeps the network busy, so wait for load and hydration instead of idle.
    await page.goto(path, { waitUntil: "load" });
    await page.waitForFunction(() => document.readyState === "complete");
    await page.waitForTimeout(500);
  }
  expect(violations).toEqual([]);
});
