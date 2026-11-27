import { createContext, use, useMemo, type ReactNode } from "react";
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
import { useResolvedColorScheme } from "@/lib/color-scheme";
import { FileCategory } from "@/lib/file-category";
import { FileIconResolver } from "@/lib/file-icon-resolver";
import { IconChoice } from "@/lib/icon-choice";
import { IconManifest } from "@/lib/icon-manifest";
import { iconChoiceQuery } from "@/lib/icon-choice-query";

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

export type FileIcons = {
  /** Theme icons for the current color scheme, or null while loading and for Lucide. */
  resolver: FileIconResolver | null;
  /** The URL of icon `index` of the theme. */
  url: (index: number) => string;
  /** The theme is still loading: draw nothing rather than an icon that is about to change. */
  pending: boolean;
};

const lucideOnly: FileIcons = { resolver: null, url: () => "", pending: false };
const FileIconsContext = createContext<FileIcons>(lucideOnly);

/**
 * The set whose manifest is at `url` (null for Nimbus's own icons), resolved for the color
 * scheme on screen. `waiting` holds icons back while the caller still learns which set to use.
 */
function useFileIcons(url: string | null, waiting = false): FileIcons {
  const manifest = useQuery(manifestQuery(url));
  const scheme = useResolvedColorScheme();
  const base = url?.slice(0, url.lastIndexOf("/") + 1) ?? "";
  const resolver = useMemo(
    () =>
      manifest.data ? FileIconResolver.create(manifest.data, scheme) : null,
    [manifest.data, scheme],
  );
  const pending = waiting || (url !== null && manifest.isPending);
  return useMemo(
    () => ({
      resolver,
      url: (index: number) => `${base}${manifest.data?.icons[index] ?? ""}`,
      pending,
    }),
    [resolver, base, manifest.data, pending],
  );
}

/** The account's icon set, resolved for the color scheme on screen. */
export function useFileIconTheme(): FileIcons {
  const choice = useQuery({
    ...iconChoiceQuery,
    placeholderData: () => IconChoice.cached() ?? undefined,
  });
  return useFileIcons(
    choice.data?.manifest ?? null,
    choice.data === undefined && choice.isPending,
  );
}

export function FileIconsProvider({ children }: { children: ReactNode }) {
  const icons = useFileIconTheme();
  return <FileIconsContext value={icons}>{children}</FileIconsContext>;
}

/** Icons from the set whose manifest is at `manifest`, as the settings previews show them. */
export function FileIconsScope({
  manifest,
  children,
}: {
  manifest: string | null;
  children: ReactNode;
}) {
  const icons = useFileIcons(manifest);
  return <FileIconsContext value={icons}>{children}</FileIconsContext>;
}

/** Nimbus's own icon for a file: a tinted page by type, or a page lettered with the extension. */
export function FallbackFileIcon({
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

/**
 * An entry's icon: its theme's own icon where the theme has a specific one, otherwise Nimbus's.
 * Icons are decorative; the entry's name labels it.
 */
export function EntryIcon({
  type,
  name,
  className,
  folderClassName,
}: {
  type: string;
  name: string;
  /** Size and placement; theme images and Lucide icons share it. */
  className: string;
  /** Extra classes for the Lucide folder icon. */
  folderClassName?: string;
}) {
  const icons = use(FileIconsContext);
  const folder = type === "dir";
  const index = icons.resolver
    ? folder
      ? icons.resolver.folder(name)
      : icons.resolver.file(name)
    : null;
  if (icons.pending) return <span aria-hidden className={className} />;
  if (index !== null)
    return (
      <img
        src={icons.url(index)}
        alt=""
        decoding="async"
        draggable={false}
        className={`${className} object-contain`}
      />
    );
  return folder ? (
    <Folder
      aria-hidden
      className={`${className} text-muted-foreground fill-muted ${folderClassName ?? ""}`}
    />
  ) : (
    <FallbackFileIcon name={name} className={className} />
  );
}
