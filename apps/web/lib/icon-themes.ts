/**
 * The file icon sets Nimbus offers without an import. Every themed set falls back to Nimbus's
 * own Lucide icons for types it has no icon for; "Lucide" is those icons alone.
 */
export type BuiltInIconThemeId =
  | "material"
  | "catppuccin"
  | "vscode-icons"
  | "symbols"
  | "lucide";

export type BuiltInIconTheme = {
  id: BuiltInIconThemeId;
  name: string;
  /** Who made the icons, for the credits beside the picker. */
  credit: string | null;
  homepage: string | null;
  /** Bundled sets work offline; the others are fetched from Open VSX the first time they are
   * chosen, then kept on the server. */
  delivery: "bundled" | "on-first-use" | "none";
};

export const defaultIconTheme: BuiltInIconThemeId = "material";

const all: readonly BuiltInIconTheme[] = [
  {
    id: "material",
    name: "Material+",
    credit: "Material Icon Theme by Material Extensions, MIT licence",
    homepage:
      "https://github.com/material-extensions/vscode-material-icon-theme",
    delivery: "bundled",
  },
  {
    id: "catppuccin",
    name: "Catppuccin+",
    credit: "Catppuccin Icons for VSCode by Catppuccin, MIT licence",
    homepage: "https://github.com/catppuccin/vscode-icons",
    delivery: "on-first-use",
  },
  {
    id: "vscode-icons",
    name: "vscode-icons+",
    credit: "vscode-icons by the vscode-icons team, MIT licence",
    homepage: "https://github.com/vscode-icons/vscode-icons",
    delivery: "on-first-use",
  },
  {
    id: "symbols",
    name: "Symbols+",
    credit: "Symbols by Miguel Solorio, MIT licence",
    homepage: "https://github.com/miguelsolorio/vscode-symbols",
    delivery: "on-first-use",
  },
  {
    id: "lucide",
    name: "Lucide",
    credit: "Lucide, ISC licence",
    homepage: "https://lucide.dev",
    delivery: "none",
  },
];

const isBuiltIn = (id: string): id is BuiltInIconThemeId =>
  all.some((theme) => theme.id === id);

const byId = new Map(all.map((theme) => [theme.id, theme]));

export const BuiltInIconThemes = {
  all,
  isBuiltIn,
  get: (id: BuiltInIconThemeId) => byId.get(id),
} as const;

/** Names the settings preview shows, chosen so most sets have an icon for each. */
export const iconPreviewNames = [
  { type: "dir", name: "src" },
  { type: "file", name: "index.ts" },
  { type: "file", name: "package.json" },
  { type: "file", name: "README.md" },
  { type: "file", name: "photo.jpg" },
  { type: "file", name: "report.pdf" },
  { type: "file", name: "notes.xyz" },
] as const;
