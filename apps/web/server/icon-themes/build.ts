/**
 * Compiles the bundled icon sets into dist/icon-themes. `bun run build` runs this after Vite,
 * which lists the files the server may serve as static files; these are not among them, and
 * are served only to signed-in accounts by /api/icon-themes.
 */
import { BuiltInIconThemeSources, bundledRoot } from "./built-in-icon-themes";

const built = await BuiltInIconThemeSources.buildBundled(bundledRoot);
if (!built.ok) {
  console.error(`The bundled icon sets were not built: ${built.error}`);
  process.exit(1);
}
console.log(
  `Bundled icon sets written to ${bundledRoot} (${Math.round(built.value.bytes / 1024)} KB).`,
);
