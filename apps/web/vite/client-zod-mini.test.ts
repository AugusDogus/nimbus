import { expect, test } from "bun:test";
import type { PluginOption, UserConfig } from "vite";
import config from "../vite.config";

const names = (plugins: PluginOption[] | undefined): string[] =>
  (plugins ?? []).flatMap((plugin) =>
    Array.isArray(plugin)
      ? names(plugin)
      : plugin && typeof plugin === "object" && "name" in plugin
        ? [plugin.name]
        : [],
  );

test("the full-Zod check also runs on the Web Worker build", async () => {
  // The probe build reads no chunk plan, so this runs before any build has written one.
  const previous = process.env.NIMBUS_CHUNK_PROBE;
  process.env.NIMBUS_CHUNK_PROBE = "1";
  let resolved: UserConfig;
  try {
    resolved =
      typeof config === "function"
        ? await config({ command: "build", mode: "production" })
        : config;
  } finally {
    if (previous === undefined) delete process.env.NIMBUS_CHUNK_PROBE;
    else process.env.NIMBUS_CHUNK_PROBE = previous;
  }
  expect(names(resolved.plugins)).toContain("nimbus-client-zod-mini");
  expect(names(await resolved.worker?.plugins?.())).toContain(
    "nimbus-client-zod-mini",
  );
});
