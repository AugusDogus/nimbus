/**
 * Nimbus's own file icon, used where an icon theme has nothing specific for a file and as the
 * whole "Lucide" set: a tinted page by category, or, for an unknown type, a page lettered with
 * its extension, so no file is ever a blank page.
 */
export type FileCategory =
  | "pdf"
  | "doc"
  | "text"
  | "markdown"
  | "sheet"
  | "slides"
  | "archive"
  | "code"
  | "web"
  | "config"
  | "settings"
  | "shell"
  | "patch"
  | "audio"
  | "video"
  | "subtitles"
  | "image"
  | "design"
  | "vector"
  | "model"
  | "disk"
  | "package"
  | "font"
  | "key"
  | "locked"
  | "database"
  | "book"
  | "map"
  | "binary"
  | "game"
  | "link";

const extensions: Record<FileCategory, readonly string[]> = {
  pdf: ["pdf"],
  doc: ["doc", "docx", "odt", "rtf", "pages"],
  text: ["txt", "log", "nfo", "sfv", "sha256", "sha1", "sha512", "md5"],
  markdown: ["md", "mdx", "markdown"],
  sheet: ["xls", "xlsx", "ods", "csv", "tsv", "numbers"],
  slides: ["ppt", "pptx", "odp", "key"],
  archive: ["zip", "tar", "gz", "tgz", "7z", "rar", "bz2", "xz", "zst", "cab"],
  code: [
    "js",
    "cjs",
    "mjs",
    "jsx",
    "ts",
    "cts",
    "mts",
    "tsx",
    "py",
    "rs",
    "go",
    "c",
    "cc",
    "cpp",
    "h",
    "hpp",
    "java",
    "kt",
    "kts",
    "swift",
    "m",
    "mm",
    "rb",
    "php",
    "css",
    "scss",
    "vue",
    "svelte",
    "lua",
    "cs",
    "dart",
    "ipynb",
    "wasm",
  ],
  web: ["html", "htm"],
  config: ["json", "jsonc", "yaml", "yml", "toml", "xml", "lock", "plist"],
  settings: ["ini", "conf", "cfg", "env", "properties"],
  shell: ["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd"],
  patch: ["patch", "diff"],
  audio: ["mp3", "m4a", "m4b", "flac", "wav", "ogg", "oga", "opus", "aac"],
  video: ["mp4", "m4v", "mov", "mkv", "webm", "avi", "ogv"],
  subtitles: ["srt", "vtt", "ass"],
  image: [
    "jpg",
    "jpeg",
    "png",
    "apng",
    "gif",
    "webp",
    "heic",
    "avif",
    "bmp",
    "tif",
    "tiff",
    "ico",
    "cr2",
    "cr3",
    "nef",
    "arw",
    "dng",
    "raf",
  ],
  design: ["psd", "ai", "fig", "sketch", "xcf", "kra"],
  vector: ["svg", "eps"],
  model: ["stl", "obj", "blend", "fbx", "glb", "gltf", "3mf"],
  disk: ["iso", "img", "dmg", "vhd", "vhdx", "qcow2"],
  package: ["deb", "rpm", "apk", "pkg", "appimage", "flatpak", "exe", "msi"],
  font: ["ttf", "otf", "woff", "woff2"],
  key: ["pem", "crt", "cer", "pub", "asc"],
  locked: ["gpg", "age", "kdbx"],
  database: ["db", "sqlite", "sqlite3", "sql"],
  book: ["epub", "mobi", "azw3"],
  map: ["gpx", "kml", "geojson"],
  binary: ["bin", "hex", "rom", "dll", "so", "dylib"],
  game: ["nes", "sfc", "gba", "nds", "z64"],
  link: ["lnk", "url", "desktop", "webloc"],
};

const names = new Map<string, FileCategory>([
  [".gitignore", "settings"],
  [".editorconfig", "settings"],
  [".ds_store", "settings"],
  ["dockerfile", "package"],
  ["makefile", "shell"],
  ["license", "doc"],
  ["readme.md", "markdown"],
]);

const isCategory = (key: string): key is FileCategory =>
  Object.hasOwn(extensions, key);
const byExtension = new Map<string, FileCategory>(
  Object.entries(extensions).flatMap(([category, list]) =>
    isCategory(category)
      ? list.map((extension): [string, FileCategory] => [extension, category])
      : [],
  ),
);

/** What a file shows as Nimbus's own icon. */
export type FileGlyph =
  | { kind: "category"; category: FileCategory }
  | { kind: "label"; text: string; category: FileCategory | null }
  | { kind: "plain" };

/** The last extension, lower-cased, or "" for a name without one. A leading dot is a name. */
const extensionOf = (lower: string) => {
  const dot = lower.lastIndexOf(".");
  return dot > 0 ? lower.slice(dot + 1) : "";
};

/**
 * Plain text keeps its page icon; other types whose category icon is only a page with lines
 * (documents, subtitles) read better lettered, as do types Nimbus has no category for.
 */
const lettered = new Set<FileCategory>(["doc", "subtitles"]);

function glyph(name: string): FileGlyph {
  const lower = name.toLowerCase();
  const extension = extensionOf(lower);
  const category = names.get(lower) ?? byExtension.get(extension) ?? null;
  if (category && !lettered.has(category))
    return { kind: "category", category };
  if (extension && extension.length <= 4)
    return { kind: "label", text: extension.toUpperCase(), category };
  return category ? { kind: "category", category } : { kind: "plain" };
}

export const FileCategory = { glyph } as const;
