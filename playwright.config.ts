import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "apps/web/e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  use: { baseURL: "http://localhost:3100", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "setup", testMatch: "auth.setup.ts", use: { ...devices["Desktop Chrome"] } },
    { name: "desktop", dependencies: ["setup"], use: { ...devices["Desktop Chrome"], storageState: "test-results/.auth/admin.json" } },
    { name: "mobile", dependencies: ["setup"], use: { ...devices["iPhone 13"], defaultBrowserType: "chromium", storageState: "test-results/.auth/admin.json" } },
  ],
  webServer: { command: "bun scripts/e2e-server.ts", url: "http://localhost:3100/api/health", timeout: 120_000, reuseExistingServer: false, gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 } },
});
