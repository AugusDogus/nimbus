import { describe, expect, test } from "bun:test";
import { FileCategory } from "./file-category";
import { FileIconResolver } from "./file-icon-resolver";
import { IconManifest } from "./icon-manifest";

const names = [
  "file",
  "folder",
  "typescript",
  "typescript-def",
  "javascript",
  "docker",
  "readme",
  "zstd",
  "sourcemap",
  "folder-src",
  "typescript-light",
  "folder-src-light",
  "markdown",
];
const icons = names.map(
  (_, index) => `${index.toString(16).padStart(32, "0")}.svg`,
);
const icon = (name: string) => names.indexOf(name);

const manifest = IconManifest.parse({
  version: 1,
  icons,
  base: {
    file: icon("file"),
    folder: icon("folder"),
    fileNames: { dockerfile: icon("docker"), "readme.md": icon("readme") },
    fileExtensions: {
      ts: icon("typescript"),
      "d.ts": icon("typescript-def"),
      "tar.zst": icon("zstd"),
      "js.map": icon("sourcemap"),
      txt: icon("file"),
    },
    languageIds: { javascript: icon("javascript"), markdown: icon("markdown") },
    folderNames: { src: icon("folder-src") },
  },
  light: {
    fileNames: {},
    fileExtensions: { ts: icon("typescript-light") },
    languageIds: {},
    folderNames: { src: icon("folder-src-light") },
  },
});
if (!manifest) throw new Error("The test manifest is invalid.");

describe("FileIconResolver", () => {
  const dark = FileIconResolver.create(manifest, "dark");

  test("matches exact file names, ignoring case", () => {
    expect(dark.file("Dockerfile")).toBe(icon("docker"));
    expect(dark.file("README.md")).toBe(icon("readme"));
  });

  test("prefers the longest matching extension", () => {
    expect(dark.file("index.d.ts")).toBe(icon("typescript-def"));
    expect(dark.file("index.ts")).toBe(icon("typescript"));
    expect(dark.file("backup.tar.zst")).toBe(icon("zstd"));
    expect(dark.file("bundle.min.js.map")).toBe(icon("sourcemap"));
    expect(dark.file("SHOUT.TS")).toBe(icon("typescript"));
  });

  test("falls back to the language VS Code gives the extension", () => {
    expect(dark.file("server.mjs")).toBe(icon("javascript"));
    expect(dark.file("notes.markdown")).toBe(icon("markdown"));
  });

  test("returns null where the theme has only its generic file icon", () => {
    expect(dark.file("notes.xyz")).toBeNull();
    expect(dark.file("plain.txt")).toBeNull();
    expect(dark.file("no-extension")).toBeNull();
    expect(dark.file("trailing.")).toBeNull();
    expect(dark.file("constructor")).toBeNull();
    expect(dark.file("x.__proto__")).toBeNull();
  });

  test("uses light overrides only in the light scheme", () => {
    const light = FileIconResolver.create(manifest, "light");
    expect(light.file("index.ts")).toBe(icon("typescript-light"));
    expect(light.file("index.d.ts")).toBe(icon("typescript-def"));
    expect(light.folder("SRC")).toBe(icon("folder-src-light"));
    expect(dark.folder("src")).toBe(icon("folder-src"));
  });

  test("gives other folders the theme's folder icon", () => {
    expect(dark.folder("Holiday photos")).toBe(icon("folder"));
  });

  test("answers repeated names from its memo", () => {
    const first = dark.file("repeat.ts");
    expect(dark.file("repeat.ts")).toBe(first);
  });
});

describe("FileCategory", () => {
  test("tints known types by category", () => {
    expect(FileCategory.glyph("song.flac")).toEqual({
      kind: "category",
      category: "audio",
    });
    expect(FileCategory.glyph("Makefile")).toEqual({
      kind: "category",
      category: "shell",
    });
  });

  test("letters short unknown extensions and plain-page categories", () => {
    expect(FileCategory.glyph("notes.xyz")).toEqual({
      kind: "label",
      text: "XYZ",
      category: null,
    });
    expect(FileCategory.glyph("letter.docx")).toEqual({
      kind: "label",
      text: "DOCX",
      category: "doc",
    });
  });

  test("shows a plain page for long or missing extensions", () => {
    expect(FileCategory.glyph("archive.unknownext")).toEqual({ kind: "plain" });
    expect(FileCategory.glyph("README")).toEqual({ kind: "plain" });
    expect(FileCategory.glyph(".hidden")).toEqual({ kind: "plain" });
  });
});
