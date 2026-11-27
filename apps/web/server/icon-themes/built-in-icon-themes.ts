import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BuiltInIconThemeId } from "@/lib/icon-themes";
import { getConfigRoot } from "../storage-paths";
import { IconThemeArchive, keptFile } from "./icon-theme-archive";
import { IconThemeCompiler, type CompileResult } from "./icon-theme-compiler";
import { IconThemeFiles } from "./icon-theme-files";
import { OpenVsxClient } from "./open-vsx-client";

/**
 * Where the built-in icon sets come from. Material ships with Nimbus, compiled at build time
 * from the `material-icon-theme` package into `dist/icon-themes`, which the build writes after
 * Vite lists the files it serves, so it is never public. The other sets are fetched from Open
 * VSX the first time someone chooses them, at the pinned version and checksum, and kept under
 * the config root for every account.
 */
type Source =
  | { kind: "bundled"; themePath: string }
  | {
      kind: "open-vsx";
      namespace: string;
      name: string;
      version: string;
      sha256: string;
      dark: string;
      light?: string;
    };

const sources: Record<Exclude<BuiltInIconThemeId, "lucide">, Source> = {
  material: {
    kind: "bundled",
    themePath: "extension/dist/material-icons.json",
  },
  catppuccin: {
    kind: "open-vsx",
    namespace: "Catppuccin",
    name: "catppuccin-vsc-icons",
    version: "1.26.0",
    sha256: "57566136d0a8ba8d040eb6e5be866c88ccbb04f3d219d3a7e52a19978900ff3d",
    dark: "catppuccin-mocha",
    light: "catppuccin-latte",
  },
  "vscode-icons": {
    kind: "open-vsx",
    namespace: "vscode-icons-team",
    name: "vscode-icons",
    version: "13.0.0",
    sha256: "89aa767f87f09dc966efe2e70bed20321d5cb5b2f43fd413598fb6913a9f99c5",
    dark: "vscode-icons",
  },
  symbols: {
    kind: "open-vsx",
    namespace: "miguelsolorio",
    name: "symbols",
    version: "0.0.26",
    sha256: "4607d914804c262ed8a722f3d024befe33174f777ed64fb2dbaf4f8bfaec49a3",
    dark: "symbols",
  },
};
export type ThemedBuiltIn = keyof typeof sources;
export const isThemedBuiltIn = (id: string): id is ThemedBuiltIn =>
  Object.hasOwn(sources, id);

const appRoot = fileURLToPath(new URL("../../", import.meta.url));
const packageRoot = path.join(appRoot, "node_modules/material-icon-theme");
/** The build's output, beside the built client. */
export const bundledRoot = path.join(appRoot, "dist/icon-themes");
/** Development servers have no build; they compile Material once into this cache. */
const developmentRoot = path.join(
  appRoot,
  "node_modules/.cache/nimbus-icon-themes",
);

/** The `material-icon-theme` package as the archive layout the compiler reads. */
async function packageFiles(root: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  // Sorted, so every build writes the same manifest and browsers keep their cached copy.
  for (const relative of (await readdir(root, { recursive: true })).sort()) {
    const name = `extension/${relative.split(path.sep).join("/")}`;
    if (!keptFile(name)) continue;
    const absolute = path.join(root, relative);
    if (!(await stat(absolute)).isFile()) continue;
    files.set(name, new Uint8Array(await readFile(absolute)));
  }
  return files;
}

/** Compiles the bundled sets into `root`. The build runs this; so does a development server. */
async function buildBundled(
  root: string,
): Promise<CompileResult<{ bytes: number }>> {
  const source = sources.material;
  if (source.kind !== "bundled")
    return { ok: false, error: "Material is not bundled." };
  if (!existsSync(packageRoot))
    return {
      ok: false,
      error: `The material-icon-theme package is not installed at ${packageRoot}. Run \`bun install\`, then build again.`,
    };
  const compiled = IconThemeCompiler.compile(await packageFiles(packageRoot), {
    dark: source.themePath,
  });
  if (!compiled.ok) return compiled;
  await IconThemeFiles.remove(path.join(root, "material"));
  const written = await IconThemeFiles.write(
    path.join(root, "material"),
    compiled.value,
  );
  return { ok: true, value: { bytes: written.bytes } };
}

let development: Promise<CompileResult<{ bytes: number }>> | null = null;

/** The bundled sets' directory, compiling them first on a development server. */
async function bundledDirectory(): Promise<string | null> {
  if (process.env.NODE_ENV === "production")
    return existsSync(bundledRoot) ? bundledRoot : null;
  if (existsSync(path.join(developmentRoot, "material")))
    return developmentRoot;
  development ??= buildBundled(developmentRoot);
  const built = await development;
  return built.ok ? developmentRoot : null;
}

const downloadedRoot = () =>
  path.join(getConfigRoot(), "icon-themes", "built-in");
const installing = new Map<ThemedBuiltIn, Promise<CompileResult<string>>>();

/** Fetches, checks and compiles a downloadable built-in set, once per server. */
async function install(
  id: ThemedBuiltIn,
  source: Extract<Source, { kind: "open-vsx" }>,
) {
  const directory = path.join(downloadedRoot(), `${id}-${source.version}`);
  const downloaded = await OpenVsxClient.download(
    source.namespace,
    source.name,
    {
      limit: 40 * 1024 * 1024,
      pinned: { version: source.version, sha256: source.sha256 },
    },
  );
  if (!downloaded.ok) return downloaded;
  const archive = IconThemeArchive.read(downloaded.value.bytes);
  if (!archive.ok) return { ok: false as const, error: archive.error };
  const listed = IconThemeCompiler.contributions(archive.files);
  if (!listed.ok) return listed;
  const pathOf = (contribution: string) => {
    const found = listed.value.themes.find(
      (theme) => theme.id === contribution,
    );
    return found ? IconThemeCompiler.themePath(found) : null;
  };
  const dark = pathOf(source.dark);
  const light = source.light === undefined ? undefined : pathOf(source.light);
  if (!dark || light === null)
    return {
      ok: false as const,
      error: `The ${source.name} extension no longer contains the expected icon themes.`,
    };
  const compiled = IconThemeCompiler.compile(archive.files, {
    dark,
    ...(light ? { light } : {}),
  });
  if (!compiled.ok) return compiled;
  await IconThemeFiles.write(directory, compiled.value);
  return { ok: true as const, value: directory };
}

/**
 * The directory holding a built-in set, or why it is unavailable. `install: false` only looks;
 * `install: true` downloads a set that is not on the server yet.
 */
async function directory(
  id: ThemedBuiltIn,
  options: { install: boolean },
): Promise<CompileResult<string> | { ok: false; error: null }> {
  const source = sources[id];
  if (source.kind === "bundled") {
    const root = await bundledDirectory();
    return root
      ? { ok: true, value: path.join(root, id) }
      : {
          ok: false,
          error:
            "The bundled Material icons are missing from this Nimbus build. Rebuild Nimbus with `bun run build`. Files show Nimbus's own icons meanwhile.",
        };
  }
  const target = path.join(downloadedRoot(), `${id}-${source.version}`);
  if (existsSync(target)) return { ok: true, value: target };
  if (!options.install) return { ok: false, error: null };
  let pending = installing.get(id);
  if (!pending) {
    pending = install(id, source).finally(() => installing.delete(id));
    installing.set(id, pending);
  }
  return pending;
}

export const BuiltInIconThemeSources = {
  directory,
  buildBundled,
} as const;
