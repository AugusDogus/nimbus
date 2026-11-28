/**
 * Every icon a folder's entries use, in one response, so a page can draw a folder's rows with
 * their final icons without a request per icon. The server lists the folder with the caller's
 * own access, resolves each entry in both color schemes and sends the pictures; the page
 * preloads this URL beside the listing, and the browser decodes the pictures before rows show.
 */
export type FolderIcons = ReadonlyMap<string, Blob>;

/** Pictures per response, at most: rows further down a huge folder load theirs as they come. */
export const maxFolderIcons = 300;

const iconFile = /^[a-f0-9]{32}\.(svg|png)$/;

/** The URL of a folder's icons in the set whose manifest is at `manifest`. */
export const folderIconsUrl = (manifest: string, folder: string) =>
  `${manifest.slice(0, manifest.lastIndexOf("/") + 1)}folder-icons?path=${encodeURIComponent(folder)}`;

/** The response body: icon file names to SVG text or base64 PNG. */
export type FolderIconsBody = { icons: Record<string, string> };

const decodeBase64 = (text: string) =>
  Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

/** The pictures in a response, by icon file name; anything unexpected is left out. */
function parse(value: unknown): FolderIcons {
  const icons = new Map<string, Blob>();
  if (typeof value !== "object" || value === null) return icons;
  const listed: unknown = Reflect.get(value, "icons");
  if (typeof listed !== "object" || listed === null) return icons;
  for (const [name, content] of Object.entries(listed)) {
    if (!iconFile.test(name) || typeof content !== "string") continue;
    if (icons.size >= maxFolderIcons) break;
    try {
      icons.set(
        name,
        name.endsWith(".svg")
          ? new Blob([content], { type: "image/svg+xml" })
          : new Blob([decodeBase64(content)], { type: "image/png" }),
      );
    } catch {
      // Malformed base64: that picture loads on its own instead.
    }
  }
  return icons;
}

export const FolderIcons = { parse } as const;
