import type { Plugin } from "vite";

/** Zod's own modules that `zod/mini` builds on; full Zod adds `v4/classic` and more. */
const miniDirectories = ["/zod/mini/", "/zod/v4/mini/", "/zod/v4/core/"];
/** Code full Zod's parsers bring: the compiled object schema and its `new Function` probe. */
const jitMarkers = ["$ZodObjectJIT", "allowsEval"];

const inZod = (id: string) => id.includes("/node_modules/zod/");
const isFullZod = (id: string) =>
  inZod(id) && !miniDirectories.some((directory) => id.includes(directory));

/**
 * Fails the client build when full Zod reaches it, from any page, at startup or later. Client
 * code validates with `zod/mini`, whose object schemas are interpreted. Full Zod's compile
 * parsers with `new Function`, and its probe for that is a violation of the pages'
 * Content-Security-Policy, which forbids eval.
 */
export function clientZodMini(): Plugin {
  return {
    name: "nimbus-client-zod-mini",
    apply: "build",
    generateBundle(_options, bundle) {
      /** The first app module, not a dependency, on a path that imports `id`. */
      const appImporter = (id: string) => {
        const seen = new Set([id]);
        const queue = [id];
        for (let next = queue.shift(); next; next = queue.shift()) {
          for (const importer of [
            ...(this.getModuleInfo(next)?.importers ?? []),
            ...(this.getModuleInfo(next)?.dynamicImporters ?? []),
          ]) {
            if (!importer.includes("/node_modules/")) return importer;
            if (!seen.has(importer)) {
              seen.add(importer);
              queue.push(importer);
            }
          }
        }
        return "an unknown module";
      };
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        const full = Object.keys(output.modules).find(isFullZod);
        const marker = jitMarkers.find((text) => output.code.includes(text));
        if (!full && !marker) continue;
        const cause = full
          ? `full Zod (${full.slice(full.lastIndexOf("/zod/") + 1)}), imported through ${appImporter(full)}`
          : `Zod's compiled parser code (${marker})`;
        this.error(
          `The client file ${output.fileName} contains ${cause}. Its parsers probe for \`new Function\`, which the pages' Content-Security-Policy reports as a violation. Import \`zod/mini\` in code the browser runs; full \`zod\` is for the server. Nothing was written.`,
        );
      }
    },
  };
}
