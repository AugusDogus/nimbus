import type { IconManifest, IconTables } from "./icon-manifest";

/**
 * The language VS Code itself gives a file, for themes that map languages rather than
 * extensions. VS Code learns these from its built-in language extensions; Nimbus has none, so
 * the common ones are listed here.
 */
const languageByExtension: Record<string, string> = {
  js: "javascript",
  cjs: "javascript",
  mjs: "javascript",
  es6: "javascript",
  jsx: "javascriptreact",
  ts: "typescript",
  cts: "typescript",
  mts: "typescript",
  tsx: "typescriptreact",
  json: "json",
  jsonc: "jsonc",
  jsonl: "jsonl",
  json5: "json5",
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  c: "c",
  h: "c",
  i: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  ino: "cpp",
  cs: "csharp",
  csx: "csharp",
  fs: "fsharp",
  fsi: "fsharp",
  fsx: "fsharp",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  groovy: "groovy",
  gradle: "groovy",
  swift: "swift",
  m: "objective-c",
  mm: "objective-cpp",
  dart: "dart",
  py: "python",
  pyw: "python",
  pyi: "python",
  rb: "ruby",
  rake: "ruby",
  gemspec: "ruby",
  php: "php",
  phtml: "php",
  pl: "perl",
  pm: "perl",
  lua: "lua",
  r: "r",
  jl: "julia",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  ksh: "shellscript",
  fish: "fish",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  bat: "bat",
  cmd: "bat",
  html: "html",
  htm: "html",
  xhtml: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  xml: "xml",
  xsd: "xml",
  xsl: "xsl",
  svg: "xml",
  plist: "xml",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  conf: "properties",
  properties: "properties",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  vue: "vue",
  svelte: "svelte",
  coffee: "coffeescript",
  hbs: "handlebars",
  handlebars: "handlebars",
  pug: "jade",
  diff: "diff",
  patch: "diff",
  rej: "diff",
  log: "log",
  txt: "plaintext",
  tex: "latex",
  bib: "bibtex",
  rst: "restructuredtext",
  clj: "clojure",
  cljs: "clojure",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  ml: "ocaml",
  mli: "ocaml",
  zig: "zig",
  nim: "nim",
  vb: "vb",
  asm: "asm",
  s: "asm",
  ipynb: "jupyter",
  dockerfile: "dockerfile",
  tf: "terraform",
  hcl: "hcl",
  proto: "proto3",
};

/** Names whose language VS Code knows without an extension. */
const languageByName: Record<string, string> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  "cmakelists.txt": "cmake",
  gemfile: "ruby",
  rakefile: "ruby",
  jenkinsfile: "groovy",
  ".gitignore": "ignore",
  ".dockerignore": "ignore",
  ".bashrc": "shellscript",
  ".zshrc": "shellscript",
  ".profile": "shellscript",
};

type Lookup = {
  file: number | undefined;
  folder: number | undefined;
  fileNames: Map<string, number>;
  fileExtensions: Map<string, number>;
  languageIds: Map<string, number>;
  folderNames: Map<string, number>;
};

// Maps, never plain objects: a file named `constructor` must not find Object.prototype's.
const lookup = (tables: IconTables | undefined): Lookup | null =>
  tables
    ? {
        file: tables.file,
        folder: tables.folder,
        fileNames: new Map(Object.entries(tables.fileNames)),
        fileExtensions: new Map(Object.entries(tables.fileExtensions)),
        languageIds: new Map(Object.entries(tables.languageIds)),
        folderNames: new Map(Object.entries(tables.folderNames)),
      }
    : null;

export type FileIconResolver = {
  /** The theme's own icon for a file, as an index into the manifest's icons, or null when the
   * theme has nothing more specific than its generic file icon. */
  file(name: string): number | null;
  /** The theme's icon for a folder, or null when the theme has no folder icon. */
  folder(name: string): number | null;
};

const memoLimit = 50_000;

/**
 * Resolves names as VS Code does: the exact file name (case-insensitive), then the longest
 * matching extension, so `.d.ts` and `.tar.zst` match whole, then the file's language. In the
 * light scheme each table's `light` overrides come first. Answers are memoised per name, so a
 * large folder costs one lookup per distinct name, not one per render.
 */
function create(
  manifest: IconManifest,
  scheme: "light" | "dark",
): FileIconResolver {
  const base = lookup(manifest.base);
  const layers = [
    scheme === "light" ? lookup(manifest.light) : null,
    base,
  ].filter((layer): layer is Lookup => layer !== null);
  const find = (
    table: "fileNames" | "fileExtensions" | "languageIds" | "folderNames",
    key: string,
  ) => {
    for (const layer of layers) {
      const icon = layer[table].get(key);
      if (icon !== undefined) return icon;
    }
    return undefined;
  };
  const generic = layers.find((layer) => layer.file !== undefined)?.file;
  const defaultFolder = layers.find(
    (layer) => layer.folder !== undefined,
  )?.folder;

  const resolveFile = (name: string): number | null => {
    const lower = name.toLowerCase();
    let icon = find("fileNames", lower);
    // Every dot starts a candidate extension; the first dot gives the longest one.
    for (
      let dot = lower.indexOf(".");
      icon === undefined && dot !== -1 && dot < lower.length - 1;
      dot = lower.indexOf(".", dot + 1)
    )
      icon = find("fileExtensions", lower.slice(dot + 1));
    if (icon === undefined) {
      const dot = lower.lastIndexOf(".");
      const language =
        languageByName[lower] ??
        (dot === -1 ? undefined : languageByExtension[lower.slice(dot + 1)]);
      if (language !== undefined) icon = find("languageIds", language);
    }
    return icon === undefined || icon === generic ? null : icon;
  };
  const resolveFolder = (name: string): number | null =>
    find("folderNames", name.toLowerCase()) ?? defaultFolder ?? null;

  const memo = (resolve: (name: string) => number | null) => {
    const cache = new Map<string, number | null>();
    return (name: string) => {
      const known = cache.get(name);
      if (known !== undefined) return known;
      if (cache.size >= memoLimit) cache.clear();
      const icon = resolve(name);
      cache.set(name, icon);
      return icon;
    };
  };
  return { file: memo(resolveFile), folder: memo(resolveFolder) };
}

export const FileIconResolver = { create } as const;
