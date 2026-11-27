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
import { readInlineJson } from "@/lib/inline-json";
import { bootstrapElementId } from "@/client/bootstrap";
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

/**
 * An entry's icon: its theme's own icon where the theme has a specific one, otherwise Nimbus's.
 * Theme icons are `<img>` elements, never inline markup from the theme, and decorative: the
 * entry's name labels it. Until the set is known it draws nothing rather than an icon that is
 * about to change.
 */
export function EntryIcon({ type, name, className, manifest }: EntryIconProps) {
  const choice = useQuery({
    ...iconChoiceQuery,
    enabled: manifest === undefined,
    initialData: sentWithPage,
    placeholderData: () => IconChoice.cached() ?? undefined,
  });
  const url = manifest === undefined ? choice.data?.manifest : manifest;
  const loaded = useQuery(manifestQuery(url ?? null));
  const scheme = useResolvedColorScheme();
  if (url === undefined || (url !== null && loaded.isPending))
    return <span aria-hidden className={className} />;
  const folder = type === "dir";
  const resolver = loaded.data ? resolverFor(loaded.data, scheme) : null;
  const index = resolver
    ? folder
      ? resolver.folder(name)
      : resolver.file(name)
    : null;
  const icon = index === null ? undefined : loaded.data?.icons[index];
  if (url !== null && icon !== undefined)
    return (
      <img
        src={`${url.slice(0, url.lastIndexOf("/") + 1)}${icon}`}
        alt=""
        decoding="async"
        draggable={false}
        className={`${className} object-contain`}
      />
    );
  return folder ? (
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
