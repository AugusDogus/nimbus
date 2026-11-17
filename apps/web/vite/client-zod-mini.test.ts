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
  const resolved: UserConfig =
    typeof config === "function"
      ? await config({ command: "build", mode: "production" })
      : config;
  expect(names(resolved.plugins)).toContain("nimbus-client-zod-mini");
  expect(names(await resolved.worker?.plugins?.())).toContain(
    "nimbus-client-zod-mini",
  );
});
