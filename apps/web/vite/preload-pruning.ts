import type { Plugin, Rolldown } from "vite";

/**
 * Shorter preload lists for code loaded on demand.
 *
 * For every `import()` in a chunk, the build writes the list of files to fetch alongside the
 * imported one, into a table in that chunk. Each list repeats every file the imported code
 * shares with the page, so a dialog opened from the file browser lists the browser's own
 * startup files again, and those lists live in the startup files themselves. A file the
 * importing chunk already imports statically is loaded before that `import()` can run, so it
 * never needs preloading: it is left out. Nothing else changes, so what is fetched when the
 * import runs is the same.
 */
export function preloadPruning() {
  /** Each chunk's static imports, by file name, as the bundle has them. */
  const imports = new Map<string, readonly string[]>();
  /** Every file loaded with `file`: itself and its static imports, transitively. */
  const loadedWith = (file: string) => {
    const loaded = new Set<string>();
    const pending = [file];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (loaded.has(next)) continue;
      loaded.add(next);
      pending.push(...(imports.get(next) ?? []));
    }
    return loaded;
  };
  /** Remembers the static imports of the bundle's chunks. */
  const record = (
    outputs: Iterable<{ type: string; fileName: string; imports?: string[] }>,
  ) => {
    imports.clear();
    for (const output of outputs)
      if (output.type === "chunk" && output.imports)
        imports.set(output.fileName, output.imports);
  };
  const plugin: Plugin = {
    name: "nimbus-prune-preloads",
    apply: "build",
    generateBundle: {
      // Before the build writes the preload lists, which `resolveDependencies` filters.
      order: "pre",
      handler(_options, bundle: Rolldown.OutputBundle) {
        record(Object.values(bundle));
      },
    },
  };
  const resolveDependencies = (
    _filename: string,
    deps: string[],
    context: { hostId: string; hostType: "html" | "js" },
  ) => {
    if (context.hostType !== "js" || !imports.has(context.hostId)) return deps;
    const loaded = loadedWith(context.hostId);
    return deps.filter((dep) => !loaded.has(dep));
  };
  return { plugin, record, resolveDependencies };
}
