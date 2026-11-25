import { defineConfig, devices } from "@playwright/test";

const port = process.env.NIMBUS_E2E_PORT ?? "3100";
const origin = `http://localhost:${port}`;

export default defineConfig({
  testDir: "apps/web/e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  use: {
    baseURL: origin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "setup",
      testMatch: "auth.setup.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "desktop",
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "test-results/.auth/admin.json",
      },
    },
    {
      name: "mobile",
      dependencies: ["setup"],
      use: {
        ...devices["iPhone 13"],
        defaultBrowserType: "chromium",
        storageState: "test-results/.auth/admin.json",
      },
    },
    // A touch tablet, wide enough for the wide layout: only the reach check runs here, which
    // covers what a finger can reach at a width the other two projects do not have.
    {
      name: "tablet",
      dependencies: ["setup"],
      testMatch: "**/reach.e2e.ts",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 950, height: 800 },
        hasTouch: true,
        storageState: "test-results/.auth/admin.json",
      },
    },
  ],
  webServer: {
    command: "bun scripts/e2e-server.ts",
    url: `${origin}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
});
