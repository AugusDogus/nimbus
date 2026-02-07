import path from "node:path";

import { defineConfig } from "@playwright/test";

const dataRoot = path.resolve(
  __dirname,
  "apps",
  "web",
  "e2e",
  "fixtures",
  "data-root",
);

export default defineConfig({
  testDir: "apps/web/e2e",
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: "http://localhost:3000",
  },
  webServer: {
    command: "bun run dev -- --env-mode=loose",
    cwd: ".",
    reuseExistingServer: false,
    env: {
      NIMBUS_TEST_SESSION: "1",
      NIMBUS_DATA_ROOT: dataRoot,
    },
  },
});
