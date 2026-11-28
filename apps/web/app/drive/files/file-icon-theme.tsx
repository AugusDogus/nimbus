// Loaded after file pages start: everything that decides and draws an entry's icon. The page's
// own code carries only the slot it fills (file-icons.tsx).
import { useSyncExternalStore } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import {
  BookOpenText,
  File,
  FileArchive,
  FileBox,
  FileBraces,
  FileChartPie,
  FileCode,
  FileCog,
  FileDatabase,
  FileDiff,
  FileDigit,
  FileImage,
  FileKey,
  FileLock,
  FileMusic,
  FilePenLine,
  FilePlay,
  FileScan,
  FileSpreadsheet,
  FileSymlink,
  FileTerminal,
  FileText,
  FileType,
  FileVideoCamera,
  Folder,
  type LucideIcon,
} from "lucide-react";
import { read, subscribe, systemScheme } from "@/lib/color-scheme";
import { FileCategory } from "@/lib/file-category";
import { FileIconResolver } from "@/lib/file-icon-resolver";
import { IconChoice } from "@/lib/icon-choice";
import { IconManifest } from "@/lib/icon-manifest";
import { iconChoiceQuery } from "@/lib/icon-choice-query";
import { queryClient } from "@/lib/trpc";
import { FolderIcons, folderIconsUrl } from "@/lib/folder-icons";
import { readInlineJson } from "@/lib/inline-json";
import { bootstrapElementId } from "@/client/bootstrap";
import { entryGeometry } from "./entry-layout";
import type { EntryIconProps } from "./file-icons";

const resolvedScheme = (): "light" | "dark" => {
  const scheme = read();
  return scheme === "system" ? systemScheme() : scheme;
};

/** The scheme on screen, `system` resolved: themes may draw other icons in light mode. */
const useResolvedColorScheme = () =>
  useSyncExternalStore(subscribe, resolvedScheme, () => "light" as const);

const glyphs: Record<FileCategory, LucideIcon> = {
  pdf: FileText,
  doc: FileText,
  text: FileText,
  markdown: FilePenLine,
  sheet: FileSpreadsheet,
  slides: FileChartPie,
  archive: FileArchive,
  code: FileCode,
  web: FileCode,
  config: FileBraces,
  settings: FileCog,
  shell: FileTerminal,
  patch: FileDiff,
  audio: FileMusic,
  video: FileVideoCamera,
  subtitles: FileText,
  image: FileImage,
  design: FileImage,
  vector: FileImage,
  model: FileBox,
  disk: FileBox,
  package: FileBox,
  font: FileType,
  key: FileKey,
  locked: FileLock,
  database: FileDatabase,
  book: BookOpenText,
  map: FileScan,
  binary: FileDigit,
  game: FilePlay,
  link: FileSymlink,
};

/** A manifest never changes under its URL, so it is fetched once per page. */
const manifestQuery = (url: string | null) =>
  queryOptions<IconManifest>({
    queryKey: ["icon-manifest", url],
    enabled: url !== null,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
    queryFn: async ({ signal }) => {
      if (url === null) throw new Error("No icon theme manifest to load.");
      const response = await fetch(url, { signal, credentials: "same-origin" });
      if (!response.ok)
        throw new Error(
          `The icon theme manifest failed to load (HTTP ${response.status}).`,
        );
      const manifest = IconManifest.parse(await response.json());
      if (!manifest)
        throw new Error("The icon theme manifest is not one Nimbus can read.");
      return manifest;
    },
  });

/**
 * Resolvers by manifest and scheme, shared by every entry on the page, so each name is looked up
 * once however many rows show it.
 */
const resolvers = new WeakMap<
  IconManifest,
  Partial<Record<"light" | "dark", FileIconResolver>>
>();
function resolverFor(manifest: IconManifest, scheme: "light" | "dark") {
  let known = resolvers.get(manifest);
  if (!known) {
    known = {};
    resolvers.set(manifest, known);
  }
  return (known[scheme] ??= FileIconResolver.create(manifest, scheme));
}

/** The set the server sent with this page, kept for the next load too. */
function sentWithPage(): IconChoice | undefined {
  const value = readInlineJson(bootstrapElementId);
  const sent =
    typeof value === "object" && value !== null
      ? IconChoice.parse(Reflect.get(value, "icons"))
      : null;
  if (sent) IconChoice.cache(sent);
  return sent ?? undefined;
}

/** The theme icon's URL for an entry, or null when Nimbus's own icon stands in. */
function themeIcon(
  url: string,
  manifest: IconManifest,
  scheme: "light" | "dark",
  type: string,
  name: string,
): string | null {
  const resolver = resolverFor(manifest, scheme);
  const index = type === "dir" ? resolver.folder(name) : resolver.file(name);
  const icon = index === null ? undefined : manifest.icons[index];
  return icon === undefined
    ? null
    : `${url.slice(0, url.lastIndexOf("/") + 1)}${icon}`;
}

const accountChoice = {
  ...iconChoiceQuery,
  initialData: sentWithPage,
  placeholderData: () => IconChoice.cached() ?? undefined,
};

/** Icons decoded for this page, kept so the browser keeps their decoded pictures too. */
const decoded = new Map<string, Promise<void>>();
/**
 * Pictures that came in a folder's icons response, as blob URLs by icon URL. Rows draw these:
 * the browser decoded them already, so they paint with the row.
 */
const pictures = new Map<string, string>();
/** Icons decoded ahead for one listing, at most; rows further down rarely use more. */
const maxIcons = 150;
/**
 * How many entries the window can show at once, in list or grid view: the listing waits for
 * their icons. Icons of the entries after them decode next, without holding the listing.
 */
function firstScreen() {
  const { list, grid } = entryGeometry;
  const rows = (height: number) => Math.ceil(innerHeight / height) + 1;
  const columns = Math.max(
    1,
    Math.floor((innerWidth + grid.gap) / (grid.minWidth + grid.gap)),
  );
  return Math.max(
    rows(list.height + list.gap),
    columns * rows(grid.minWidth * grid.aspect + grid.gap),
  );
}

/** Fetches a folder's icons in one response, for icons not loaded yet. */
async function loadFolderIcons(manifestUrl: string, folder: string) {
  const response = await fetch(folderIconsUrl(manifestUrl, folder), {
    credentials: "same-origin",
  });
  if (!response.ok) return;
  const base = manifestUrl.slice(0, manifestUrl.lastIndexOf("/") + 1);
  for (const [name, blob] of FolderIcons.parse(await response.json())) {
    const url = `${base}${name}`;
    if (!pictures.has(url)) pictures.set(url, URL.createObjectURL(blob));
  }
}

/**
 * Loads the account's set and decodes the icons `entries` use, so rows that show them paint
 * their final icon in their first frame. `entries` come in the order the page shows them; it
 * waits for the first screen's icons and starts the rest. Given the folder they list, the icons it needs come in
 * one response (which the page preloads for its first folder) rather than one request each.
 * See `prepareEntryIcons` in file-icons.tsx.
 */
export async function prepareEntries(
  entries: readonly { type: string; name: string }[],
  folder?: string,
): Promise<void> {
  const choice = await queryClient.ensureQueryData(accountChoice);
  if (choice.manifest === null) return;
  const manifest = await queryClient.ensureQueryData(
    manifestQuery(choice.manifest),
  );
  const scheme = resolvedScheme();
  const urls = new Set<string>();
  const first = new Set<string>();
  const shown = firstScreen();
  for (const [position, entry] of entries.entries()) {
    const icon = themeIcon(
      choice.manifest,
      manifest,
      scheme,
      entry.type,
      entry.name,
    );
    if (icon !== null) {
      urls.add(icon);
      if (position < shown) first.add(icon);
    }
    if (urls.size >= maxIcons) break;
  }
  if (
    folder !== undefined &&
    [...urls].some((url) => !decoded.has(url) && !pictures.has(url))
  )
    await loadFolderIcons(choice.manifest, folder).catch(() => {
      // Each picture then loads on its own.
    });
  const awaited: Promise<void>[] = [];
  for (const url of urls) {
    let done = decoded.get(url);
    if (!done) {
      const image = new Image();
      image.src = pictures.get(url) ?? url;
      // A picture that fails draws as the browser draws a broken image; it does not hold the
      // listing back.
      done = image.decode().catch(() => undefined);
      decoded.set(url, done);
    }
    if (first.has(url)) awaited.push(done);
  }
  await Promise.all(awaited);
}

/**
 * An entry's icon: its theme's own icon where the theme has a specific one, otherwise Nimbus's.
 * Theme icons are `<img>` elements, never inline markup from the theme, and decorative: the
 * entry's name labels it. Listings wait for `prepareEntries`, so in a row the set, the manifest
 * and the picture are all ready when it first renders; settings previews draw nothing until
 * their set loads rather than an icon that is about to change.
 */
export function EntryIcon({ type, name, className, manifest }: EntryIconProps) {
  const choice = useQuery({
    ...accountChoice,
    enabled: manifest === undefined,
  });
  const url = manifest === undefined ? choice.data?.manifest : manifest;
  const loaded = useQuery(manifestQuery(url ?? null));
  const scheme = useResolvedColorScheme();
  if (url === undefined || (url !== null && loaded.isPending))
    return <span aria-hidden className={className} />;
  const icon =
    url !== null && loaded.data
      ? themeIcon(url, loaded.data, scheme, type, name)
      : null;
  if (icon !== null)
    return (
      <img
        src={pictures.get(icon) ?? icon}
        // The icon's own address; `src` may be the decoded copy from the folder's icons.
        data-icon={icon}
        alt=""
        // Decoded ahead by `prepareEntries`, so drawing it waits for nothing.
        decoding="sync"
        draggable={false}
        className={`${className} object-contain`}
      />
    );
  return type === "dir" ? (
    <Folder
      aria-hidden
      className={`${className} fill-muted text-muted-foreground`}
    />
  ) : (
    <FallbackFileIcon name={name} className={className} />
  );
}

/** Nimbus's own icon for a file: a tinted page by type, or a page lettered with the extension. */
function FallbackFileIcon({
  name,
  className,
}: {
  name: string;
  className: string;
}) {
  const glyph = FileCategory.glyph(name);
  if (glyph.kind === "label") {
    const tint = glyph.category ? `var(--file-${glyph.category})` : undefined;
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className={className}
        style={tint ? { color: tint } : undefined}
      >
        <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
        <path d="M14 2v5a1 1 0 0 0 1 1h5" />
        <text
          x="12"
          y="17.6"
          textAnchor="middle"
          fontSize={glyph.text.length > 3 ? 5.2 : 6.2}
          fontWeight={700}
          fill="currentColor"
          stroke="none"
          letterSpacing="-0.2"
          style={{ fontFamily: "inherit" }}
        >
          {glyph.text}
        </text>
      </svg>
    );
  }
  const Icon = glyph.kind === "category" ? glyphs[glyph.category] : File;
  return (
    <Icon
      aria-hidden
      className={className}
      style={
        glyph.kind === "category"
          ? { color: `var(--file-${glyph.category})` }
          : undefined
      }
    />
  );
}
