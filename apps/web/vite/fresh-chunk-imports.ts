import type { Plugin } from "vite";

/** A dynamic import of a built chunk beside the importing one, as the bundler writes it. */
const chunkImport = /\bimport\((["'`])\.\/([\w.-]+\.js)\1\)/g;

/**
 * `code` with every `import()` of a chunk asking `nimbusChunkUrl` for the address to load (see
 * lib/code-load.ts), so a load that failed can be tried again with a new request: browsers keep
 * a failed module's failure for its address and never ask for that address again. Before the
 * page's code defines it, the address is the chunk's own.
 *
 * Fails when a chunk in `dynamicImports` has no import this recognises, or when an import of a
 * chunk is left as it was, so a change in the bundler's output never passes unnoticed.
 */
export function freshChunkImports(
  code: string,
  fileName: string,
  dynamicImports: readonly string[],
): string {
  const rewritten = new Set<string>();
  const result = code.replace(
    chunkImport,
    (_match, quote: string, file: string) => {
      rewritten.add(file);
      return `import((globalThis.nimbusChunkUrl||String)(${quote}./${file}${quote}))`;
    },
  );
  const missed = dynamicImports
    .map((file) => file.slice(file.lastIndexOf("/") + 1))
    .filter((file) => !rewritten.has(file));
  if (missed.length > 0)
    throw new Error(
      `${fileName} imports ${missed.join(", ")} in a way vite/fresh-chunk-imports.ts does not recognise, so a failed load of it could never be tried again. Update the pattern there for the bundler's output.`,
    );
  return result;
}

/** Applies `freshChunkImports` to every chunk of the client build, once it is final. */
export function freshChunkImportsPlugin(): Plugin {
  return {
    name: "nimbus-fresh-chunk-imports",
    apply: "build",
    generateBundle: {
      // After Vite has read each import to write its preload list.
      order: "post",
      handler(_options, bundle) {
        for (const output of Object.values(bundle))
          if (output.type === "chunk")
            output.code = freshChunkImports(
              output.code,
              output.fileName,
              output.dynamicImports,
            );
      },
    },
  };
}
