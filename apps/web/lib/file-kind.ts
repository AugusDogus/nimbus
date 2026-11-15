/**
 * What a file is, decided from its name only. Every preview, thumbnail and
 * served Content-Type derives from this table so the client and server agree.
 * Text-like kinds are always served as text/plain: the browser never renders
 * user markup itself.
 */
export type CodeLanguage =
  | "c"
  | "cpp"
  | "csharp"
  | "css"
  | "go"
  | "html"
  | "java"
  | "javascript"
  | "json"
  | "kotlin"
  | "lua"
  | "php"
  | "python"
  | "ruby"
  | "rust"
  | "shell"
  | "sql"
  | "swift"
  | "toml"
  | "typescript"
  | "xml"
  | "yaml";

export type FileKind =
  | { type: "image"; mime: string }
  | { type: "video"; mime: string }
  | { type: "audio"; mime: string }
  | { type: "pdf" }
  | { type: "markdown" }
  | { type: "table"; delimiter: "," | "\t" }
  | { type: "code"; language: CodeLanguage }
  | { type: "text" }
  | { type: "other" };

const image = (mime: string): FileKind => ({ type: "image", mime });
const video = (mime: string): FileKind => ({ type: "video", mime });
const audio = (mime: string): FileKind => ({ type: "audio", mime });
const code = (language: CodeLanguage): FileKind => ({ type: "code", language });
const text: FileKind = { type: "text" };

const byExtension: Record<string, FileKind> = {
  png: image("image/png"),
  apng: image("image/apng"),
  jpg: image("image/jpeg"),
  jpeg: image("image/jpeg"),
  gif: image("image/gif"),
  webp: image("image/webp"),
  avif: image("image/avif"),
  tif: image("image/tiff"),
  tiff: image("image/tiff"),
  bmp: image("image/bmp"),
  ico: image("image/x-icon"),
  svg: image("image/svg+xml"),
  mp4: video("video/mp4"),
  m4v: video("video/mp4"),
  mov: video("video/quicktime"),
  webm: video("video/webm"),
  mkv: video("video/x-matroska"),
  ogv: video("video/ogg"),
  mp3: audio("audio/mpeg"),
  m4a: audio("audio/mp4"),
  aac: audio("audio/aac"),
  flac: audio("audio/flac"),
  wav: audio("audio/wav"),
  ogg: audio("audio/ogg"),
  oga: audio("audio/ogg"),
  opus: audio("audio/ogg"),
  weba: audio("audio/webm"),
  pdf: { type: "pdf" },
  md: { type: "markdown" },
  markdown: { type: "markdown" },
  csv: { type: "table", delimiter: "," },
  tsv: { type: "table", delimiter: "\t" },
  c: code("c"),
  h: code("c"),
  cc: code("cpp"),
  cpp: code("cpp"),
  hpp: code("cpp"),
  cs: code("csharp"),
  css: code("css"),
  go: code("go"),
  htm: code("html"),
  html: code("html"),
  java: code("java"),
  js: code("javascript"),
  cjs: code("javascript"),
  mjs: code("javascript"),
  jsx: code("javascript"),
  json: code("json"),
  jsonc: code("json"),
  kt: code("kotlin"),
  lua: code("lua"),
  php: code("php"),
  py: code("python"),
  rb: code("ruby"),
  rs: code("rust"),
  sh: code("shell"),
  bash: code("shell"),
  zsh: code("shell"),
  sql: code("sql"),
  swift: code("swift"),
  toml: code("toml"),
  ts: code("typescript"),
  mts: code("typescript"),
  cts: code("typescript"),
  tsx: code("typescript"),
  xml: code("xml"),
  yml: code("yaml"),
  yaml: code("yaml"),
  txt: text,
  log: text,
  ini: text,
  conf: text,
  cfg: text,
  env: text,
  srt: text,
  vtt: text,
};

const byName: Record<string, FileKind> = {
  dockerfile: code("shell"),
  makefile: code("shell"),
  ".gitignore": text,
  ".dockerignore": text,
  ".editorconfig": text,
  license: text,
};

const other: FileKind = { type: "other" };

export const FileKind = {
  of(name: string): FileKind {
    const lower = name.toLowerCase();
    const named = byName[lower];
    if (named) return named;
    const dot = lower.lastIndexOf(".");
    if (dot <= 0) return other;
    return byExtension[lower.slice(dot + 1)] ?? other;
  },
  /** Kinds read as UTF-8 text and shown in the text viewer or editor. */
  isText(kind: FileKind) {
    return (
      kind.type === "markdown" ||
      kind.type === "table" ||
      kind.type === "code" ||
      kind.type === "text"
    );
  },
  /** Content-Type for inline previews. Anything unknown downloads as bytes. */
  previewContentType(kind: FileKind) {
    switch (kind.type) {
      case "image":
      case "video":
      case "audio":
        return kind.mime;
      case "pdf":
        return "application/pdf";
      case "markdown":
      case "table":
      case "code":
      case "text":
        return "text/plain; charset=utf-8";
      case "other":
        return "application/octet-stream";
    }
  },
} as const;
