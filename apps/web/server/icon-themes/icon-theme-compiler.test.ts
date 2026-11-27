import { describe, expect, test } from "bun:test";
import { strToU8, zipSync, type Zippable } from "fflate";
import { FileIconResolver } from "@/lib/file-icon-resolver";
import { archiveLimits, IconThemeArchive } from "./icon-theme-archive";
import { IconThemeCompiler } from "./icon-theme-compiler";
import { BuiltInIconThemeSources } from "./built-in-icon-themes";

const svg = (color: string) =>
  strToU8(
    `<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="${color}"/></svg>`,
  );
const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
const json = (value: unknown) => strToU8(JSON.stringify(value));
/** A refused result's message, or null when it succeeded. */
const errorOf = (result: object) =>
  "error" in result && typeof result.error === "string" ? result.error : null;

const manifest = (themes: { id: string; path: string }[]) =>
  json({
    name: "pixel-icons",
    license: "MIT",
    contributes: {
      iconThemes: themes.map((theme) => ({ ...theme, label: theme.id })),
    },
  });

const theme = {
  iconDefinitions: {
    file: { iconPath: "./icons/file.svg" },
    folder: { iconPath: "./icons/folder.svg" },
    ts: { iconPath: "./icons/ts.svg" },
    tsLight: { iconPath: "./icons/ts-light.svg" },
    json: { iconPath: "./icons/json.png" },
    missing: { iconPath: "./icons/missing.svg" },
    placeholder: { iconPath: "" },
  },
  file: "file",
  folder: "folder",
  fileExtensions: { TS: "ts", gone: "missing" },
  fileNames: { "package.json": "json" },
  languageIds: {},
  folderNames: {},
  light: { fileExtensions: { ts: "tsLight" } },
};

const extension = (overrides: Zippable = {}) =>
  zipSync({
    "extension/package.json": manifest([
      { id: "pixel", path: "./themes/pixel.json" },
    ]),
    "extension/LICENSE.txt": strToU8("MIT License\n\nCopyright (c) example"),
    "extension/themes/pixel.json": json(theme),
    "extension/themes/icons/file.svg": svg("#777"),
    "extension/themes/icons/folder.svg": svg("#a80"),
    "extension/themes/icons/ts.svg": svg("#06c"),
    "extension/themes/icons/ts-light.svg": svg("#09f"),
    "extension/themes/icons/json.png": png,
    "extension/readme.md": strToU8("# Pixel icons"),
    ...overrides,
  });

function compileArchive(bytes: Uint8Array) {
  const archive = IconThemeArchive.read(bytes);
  if (!archive.ok) return archive;
  const listed = IconThemeCompiler.contributions(archive.files);
  if (!listed.ok) return listed;
  const [first] = listed.value.themes;
  const path = first ? IconThemeCompiler.themePath(first) : null;
  if (!path) return { ok: false as const, error: "no theme path" };
  return IconThemeCompiler.compile(archive.files, { dark: path });
}

describe("IconThemeArchive", () => {
  test("keeps manifests, icons and the licence, and nothing else", () => {
    const archive = IconThemeArchive.read(extension());
    if (!archive.ok) throw new Error(archive.error);
    expect([...archive.files.keys()].sort()).toEqual([
      "extension/LICENSE.txt",
      "extension/package.json",
      "extension/themes/icons/file.svg",
      "extension/themes/icons/folder.svg",
      "extension/themes/icons/json.png",
      "extension/themes/icons/ts-light.svg",
      "extension/themes/icons/ts.svg",
      "extension/themes/pixel.json",
    ]);
  });

  test("refuses paths that climb out of the archive or are absolute", () => {
    for (const name of [
      "extension/../outside.svg",
      "../outside.svg",
      "/etc/outside.svg",
      "extension\\icons\\a.svg",
      "C:/outside.svg",
    ]) {
      const result = IconThemeArchive.read(extension({ [name]: svg("#000") }));
      expect(result.ok, name).toBe(false);
      if (!result.ok) expect(result.error).toContain("unsafe path");
    }
  });

  test("refuses symbolic links", () => {
    const link: Zippable = {
      "extension/themes/icons/link.svg": [
        strToU8("/etc/passwd"),
        { os: 3, attrs: 0o120777 << 16 },
      ],
    };
    const result = IconThemeArchive.read(extension(link));
    expect(errorOf(result)).toContain("symbolic link");
  });

  test("enforces the download, file count, file size and unpacked size caps", () => {
    const bytes = extension();
    const tight = (overrides: Partial<typeof archiveLimits>) =>
      IconThemeArchive.read(bytes, { ...archiveLimits, ...overrides });
    expect(tight({ archiveBytes: 100 }).ok).toBe(false);
    expect(errorOf(tight({ entries: 3 }))).toContain("more than 3 files");
    expect(errorOf(tight({ fileBytes: 50 }))).toContain("larger than");
    expect(errorOf(tight({ unpackedBytes: 400 }))).toContain(
      "unpack to more than",
    );
  });

  test("refuses something that is not a zip", () => {
    expect(IconThemeArchive.read(strToU8("not a zip")).ok).toBe(false);
  });
});

describe("IconThemeCompiler", () => {
  test("compiles associations to hashed icons, keeping light overrides", () => {
    const compiled = compileArchive(extension());
    if (!compiled.ok) throw new Error(compiled.error);
    const { manifest: result, icons, licence } = compiled.value;
    expect(
      result.icons.every((name) => /^[a-f0-9]{32}\.(svg|png)$/.test(name)),
    ).toBe(true);
    expect(icons.size).toBe(5);
    expect(licence).toContain("MIT License");
    // Keys are lower-cased; definitions whose file is missing are dropped.
    expect(Object.keys(result.base.fileExtensions)).toEqual(["ts"]);
    const dark = FileIconResolver.create(result, "dark");
    const light = FileIconResolver.create(result, "light");
    expect(dark.file("index.ts")).not.toBeNull();
    expect(light.file("index.ts")).not.toBe(dark.file("index.ts"));
    expect(result.icons[dark.file("package.json") ?? -1]).toMatch(/\.png$/);
    expect(dark.file("notes.txt")).toBeNull();
    expect(dark.folder("anything")).not.toBeNull();
  });

  test("refuses font-based themes", () => {
    const compiled = compileArchive(
      extension({
        "extension/themes/pixel.json": json({
          fonts: [
            { id: "seti", src: [{ path: "./seti.woff", format: "woff" }] },
          ],
          iconDefinitions: {
            ts: { fontCharacter: "\\E001", fontColor: "#519aba" },
          },
          file: "ts",
          fileExtensions: { ts: "ts" },
        }),
      }),
    );
    expect(errorOf(compiled)).toContain("draws its icons with a font");
  });

  test("refuses icons whose content is not what their name says", () => {
    const html = compileArchive(
      extension({
        "extension/themes/icons/ts.svg": strToU8(
          "<html><script>alert(1)</script></html>",
        ),
      }),
    );
    expect(errorOf(html)).toContain("not a valid SVG");
    const fakePng = compileArchive(
      extension({ "extension/themes/icons/json.png": svg("#000") }),
    );
    expect(errorOf(fakePng)).toContain("not a valid PNG");
  });

  test("refuses icon types other than SVG and PNG, and paths outside the extension", () => {
    const jpeg = compileArchive(
      extension({
        "extension/themes/pixel.json": json({
          ...theme,
          iconDefinitions: {
            ...theme.iconDefinitions,
            ts: { iconPath: "./icons/ts.jpg" },
          },
        }),
      }),
    );
    expect(errorOf(jpeg)).toContain("not an SVG or PNG");
    const escape = compileArchive(
      extension({
        "extension/themes/pixel.json": json({
          ...theme,
          iconDefinitions: {
            ...theme.iconDefinitions,
            ts: { iconPath: "../../../../etc/x.svg" },
          },
        }),
      }),
    );
    expect(errorOf(escape)).toContain("outside the extension");
  });

  test("explains an extension with no icon themes", () => {
    const archive = IconThemeArchive.read(
      extension({
        "extension/package.json": json({ contributes: { themes: [] } }),
      }),
    );
    if (!archive.ok) throw new Error(archive.error);
    expect(errorOf(IconThemeCompiler.contributions(archive.files))).toContain(
      "contributes no file icon themes",
    );
  });
});

test("the bundled Material set resolves names as VS Code does", async () => {
  const root = `/tmp/nimbus-material-${crypto.randomUUID()}`;
  const built = await BuiltInIconThemeSources.buildBundled(root);
  if (!built.ok) throw new Error(built.error);
  const manifestFile = [
    ...new Bun.Glob("material/manifest-*.json").scanSync(root),
  ][0];
  if (!manifestFile) throw new Error("No manifest was written.");
  const { IconManifest } = await import("@/lib/icon-manifest");
  const parsed = IconManifest.parse(
    await Bun.file(`${root}/${manifestFile}`).json(),
  );
  if (!parsed) throw new Error("The manifest does not parse.");
  const dark = FileIconResolver.create(parsed, "dark");
  expect(dark.file("index.ts")).not.toBeNull();
  expect(dark.file("index.d.ts")).not.toBe(dark.file("index.ts"));
  expect(dark.file("package.json")).not.toBeNull();
  expect(dark.file("Dockerfile")).not.toBeNull();
  expect(dark.file("notes.xyz")).toBeNull();
  expect(dark.folder("src")).not.toBe(dark.folder("Holiday plans"));
  expect(await Bun.file(`${root}/material/LICENSE.txt`).text()).toContain(
    "MIT",
  );
  await Bun.$`rm -rf ${root}`;
});
