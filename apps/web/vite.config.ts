import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { clientZodMini } from "./vite/client-zod-mini";
import { freshChunkImportsPlugin } from "./vite/fresh-chunk-imports";
import { preloadPruning } from "./vite/preload-pruning";
import { routeChunkRecovery } from "./vite/route-chunk-recovery";
import { startupChunkGroups } from "./vite/startup-chunk-groups";
import { htmlNonce } from "./client/html-nonce";
import { builtFilesList } from "./server/static-files";
import { themeBoot } from "./lib/theme-boot-script";

const root = fileURLToPath(new URL(".", import.meta.url));
const chunkPlan = path.join(root, "node_modules/.cache/nimbus-chunk-plan.json");

/**
 * Runs the theme boot script inline, right after the custom theme style element it fills, before
 * the first paint. It carries the per-request nonce like every other script the server sends.
 */
function themeBootScript(): Plugin {
  const marker = "<!-- nimbus:theme-boot -->";
  return {
    name: "nimbus-theme-boot",
    transformIndexHtml: (html) => {
      if (!html.includes(marker))
        throw new Error(
          `index.html has no ${marker} marker, so the theme would apply only after the app loads. Restore the marker after the custom theme style element.`,
        );
      return html.replace(
        marker,
        `<script nonce="${htmlNonce}">${themeBoot}</script>`,
      );
    },
  };
}

/**
 * Preloads the latin Inter font, which sets nearly all text, so the first paint usually uses it.
 * Geist Mono and the Fredoka wordmark swap in from metric-matched fallbacks; preloading them too
 * measured slower on slow connections, where they compete with the app's code.
 */
function preloadFonts(): Plugin {
  const fonts = ["inter-latin-opsz-normal"];
  return {
    name: "nimbus-preload-fonts",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, context) {
        const files = Object.values(context.bundle ?? {}).filter(
          (file) => file.type === "asset" && file.fileName.endsWith(".woff2"),
        );
        return fonts.map((font) => {
          const file = files.find((asset) =>
            asset.fileName.startsWith(`assets/${font}-`),
          );
          if (!file)
            throw new Error(
              `The build has no ${font}.woff2 to preload. Check the font imports in app/fonts.css.`,
            );
          return {
            tag: "link",
            attrs: {
              rel: "preload",
              href: `/${file.fileName}`,
              as: "font",
              type: "font/woff2",
              crossorigin: "",
            },
            injectTo: "head",
          };
        });
      },
    },
  };
}

/**
 * Writes brotli and gzip variants beside each compressible file, at the highest levels, so the
 * server never compresses them per request. The HTML shell is compressed per response instead,
 * because every response carries its own nonce. Then lists every file the build wrote.
 */
function precompress(): Plugin {
  const compressible = /\.(js|css|svg|json|webmanifest|txt|html)$/;
  let outDir = "";
  return {
    name: "nimbus-precompress",
    // The chunk probe build is thrown away, so it needs no compressed copies.
    apply: (_config, env) =>
      env.command === "build" && process.env.NIMBUS_CHUNK_PROBE !== "1",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const names = await readdir(outDir, { recursive: true });
      await Promise.all(
        names
          .filter((name) => compressible.test(name) && name !== "index.html")
          .map(async (name) => {
            const file = path.join(outDir, name);
            const body = await readFile(file);
            if (body.byteLength < 1024) return;
            const brotli = brotliCompressSync(body, {
              params: {
                [constants.BROTLI_PARAM_QUALITY]: 11,
                [constants.BROTLI_PARAM_SIZE_HINT]: body.byteLength,
              },
            });
            const gzip = gzipSync(body, { level: 9 });
            await Promise.all([
              brotli.byteLength < body.byteLength &&
                writeFile(`${file}.br`, brotli),
              gzip.byteLength < body.byteLength &&
                writeFile(`${file}.gz`, gzip),
            ]);
          }),
      );
      // The server serves only these files, so nothing placed in the build directory later is
      // ever published. This runs last, after every file the build writes.
      const written = await readdir(outDir, {
        recursive: true,
        withFileTypes: true,
      });
      await writeFile(
        path.join(outDir, builtFilesList),
        JSON.stringify(
          written
            .filter((entry) => entry.isFile())
            .map((entry) =>
              path
                .relative(outDir, path.join(entry.parentPath, entry.name))
                .split(path.sep)
                .join("/"),
            )
            .filter((name) => !name.startsWith(".vite/")),
        ),
      );
    },
  };
}

export default defineConfig(({ command }) => {
  const startup =
    command === "build" ? startupChunkGroups(root, chunkPlan, 0) : undefined;
  const preloads = preloadPruning();
  return {
    root,
    resolve: { tsconfigPaths: true },
    html: { cspNonce: htmlNonce },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      manifest: true,
      // Every browser the build targets but Safari 16.4 to 16.x preloads modules natively;
      // without the polyfill those few simply skip preloading.
      modulePreload: {
        polyfill: false,
        // Files the importing code already loaded need no preloading again.
        resolveDependencies: preloads.resolveDependencies,
      },
      rolldownOptions: {
        // The public share and upload pages and the sign-in pages are server-rendered and
        // hydrate through entries of their own, which load none of the signed-in app.
        input: {
          index: path.join(root, "index.html"),
          share: path.join(root, "share.html"),
          "file-request": path.join(root, "file-request.html"),
          auth: path.join(root, "auth.html"),
        },
        output: { codeSplitting: startup?.codeSplitting ?? true },
      },
    },
    // Web Workers are a separate build, which the app's plugins do not see.
    worker: { plugins: () => [clientZodMini()] },
    optimizeDeps: {
      // Scan every client module up front, including ones loaded only when a preview or dialog
      // opens, so the dev server never finds a new dependency mid-session and reloads the page.
      entries: [
        "index.html",
        "{app,client,components,hooks,lib,routes}/**/*.{ts,tsx}",
        "!**/*.test.{ts,tsx}",
      ],
    },
    server: {
      host: "localhost",
      port: Number(process.env.NIMBUS_VITE_PORT ?? "5173"),
      strictPort: true,
      // Pages load through the Nimbus server, which forwards module requests here. The HMR
      // socket connects to this port directly.
      ws: { clientPort: Number(process.env.NIMBUS_VITE_PORT ?? "5173") },
    },
    plugins: [
      tanstackRouter({
        target: "react",
        autoCodeSplitting: true,
        routesDirectory: "routes",
        generatedRouteTree: "client/route-tree.gen.ts",
      }),
      routeChunkRecovery(
        path.join(root, "routes/"),
        path.join(root, "client/lazy-route.ts"),
      ),
      react(),
      tailwindcss(),
      themeBootScript(),
      preloadFonts(),
      precompress(),
      startup?.plugin,
      preloads.plugin,
      freshChunkImportsPlugin(),
      clientZodMini(),
    ],
  };
});
