import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";

/**
 * A stand-in for Open VSX, so e2e tests import icon themes without the internet. The e2e server
 * points Nimbus at it with NIMBUS_OPEN_VSX_URL. It offers an SVG icon theme, a font-based one
 * Nimbus must refuse, and a color theme its icon search must leave out.
 */
const svg = (color: string, label: string) =>
  strToU8(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="${color}"/><text x="8" y="11" font-size="7" text-anchor="middle" fill="#fff">${label}</text></svg>`,
  );
const json = (value: unknown) => strToU8(JSON.stringify(value));

const extensions = {
  "pixel-icons": {
    displayName: "Pixel Icons",
    description: "Square icons for a test.",
    files: {
      "extension/package.json": json({
        name: "pixel-icons",
        displayName: "Pixel Icons",
        license: "MIT",
        contributes: {
          iconThemes: [
            { id: "pixel", label: "Pixel Icons", path: "./theme/pixel.json" },
          ],
        },
      }),
      "extension/LICENSE": strToU8("MIT License\n\nCopyright (c) Example"),
      "extension/theme/pixel.json": json({
        iconDefinitions: {
          file: { iconPath: "./file.svg" },
          folder: { iconPath: "./folder.svg" },
          ts: { iconPath: "./ts.svg" },
        },
        file: "file",
        folder: "folder",
        fileExtensions: { ts: "ts" },
      }),
      "extension/theme/file.svg": svg("#777777", ""),
      "extension/theme/folder.svg": svg("#c08000", ""),
      "extension/theme/ts.svg": svg("#2050c0", "TS"),
    },
  },
  "glyph-icons": {
    displayName: "Glyph Icons",
    description: "Icons drawn with a font.",
    files: {
      "extension/package.json": json({
        name: "glyph-icons",
        contributes: {
          iconThemes: [
            { id: "glyph", label: "Glyph Icons", path: "./glyph.json" },
          ],
        },
      }),
      "extension/glyph.json": json({
        fonts: [
          { id: "glyph", src: [{ path: "./glyph.woff", format: "woff" }] },
        ],
        iconDefinitions: { ts: { fontCharacter: "\\E001" } },
        file: "ts",
      }),
    },
  },
  "paper-colors": {
    displayName: "Paper Colors",
    description: "A color theme, not icons.",
    files: {
      "extension/package.json": json({
        name: "paper-colors",
        contributes: {
          themes: [{ label: "Paper", uiTheme: "vs", path: "./paper.json" }],
        },
      }),
    },
  },
} as const;

type Name = keyof typeof extensions;
const isName = (value: string): value is Name =>
  Object.hasOwn(extensions, value);
const archives = new Map(
  Object.entries(extensions).map(([name, extension]) => [
    name,
    zipSync({ ...extension.files }),
  ]),
);

export function startOpenVsxFixture(port: number) {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/-/search")
        return Response.json({
          extensions: Object.entries(extensions).map(([name, extension]) => ({
            namespace: "example",
            name,
            version: "1.0.0",
            displayName: extension.displayName,
            description: extension.description,
          })),
        });
      const parts = url.pathname.split("/").slice(2);
      const [namespace, name = "", version, kind, file] = parts;
      if (namespace !== "example" || !isName(name))
        return new Response("Not found", { status: 404 });
      const archive = archives.get(name);
      if (!archive) return new Response("Not found", { status: 404 });
      if (parts.length === 2)
        return Response.json({
          namespace,
          name,
          version: "1.0.0",
          displayName: extensions[name].displayName,
        });
      if (version !== "1.0.0" || kind !== "file")
        return new Response("Not found", { status: 404 });
      if (file === "package.json")
        return new Response(extensions[name].files["extension/package.json"]);
      if (file === `example.${name}-1.0.0.vsix`) return new Response(archive);
      if (file === `example.${name}-1.0.0.sha256`)
        return new Response(
          `${createHash("sha256").update(archive).digest("hex")}  example.${name}-1.0.0.vsix\n`,
        );
      return new Response("Not found", { status: 404 });
    },
  });
}
