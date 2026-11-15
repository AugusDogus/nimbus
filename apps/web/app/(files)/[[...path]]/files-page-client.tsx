"use client";

import { Folder, HardDrive } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { useSession } from "@/lib/auth-client";
import { decodeFilePathSegments } from "@/lib/file-route";

import { FileBreadcrumbs } from "./breadcrumbs";
import { EntriesView } from "./entries-view";
import { FiltersRow } from "./filters-row";
import { LoadingSkeleton } from "./loading-skeleton";
import { useFileActions } from "./use-file-actions";
import { useFileList } from "./use-file-list";
import { useFilePreferences } from "./use-file-preferences";

type SessionData = ReturnType<typeof useSession>["data"];

type Params = {
  path?: string[] | string;
};

type FilesPageClientProps = {
  pathSegments: string[];
  initialSession: SessionData | null;
  initialPrefs: ReturnType<typeof useFilePreferences>["prefs"] | null;
  initialEntries: ReturnType<typeof useFileList>["entries"] | null;
};

export function FilesPageClient({
  pathSegments,
  initialSession,
  initialPrefs,
  initialEntries,
}: FilesPageClientProps) {
  const params = useParams<Params>();
  const paramSegments = useMemo(
    () => decodeFilePathSegments(params?.path),
    [params?.path],
  );
  const effectiveSegments =
    paramSegments.length > 0 ? paramSegments : pathSegments;
  const currentPath = effectiveSegments.join("/");
  const { data: sessionData, isPending } = useSession();
  const session = isPending ? initialSession : sessionData;
  const isAuthed = Boolean(session);

  const { prefs, updatePreferences } = useFilePreferences(
    isAuthed,
    initialPrefs ?? undefined,
  );
  const view = prefs.view;

  const includeStats =
    prefs.sortField === "modified" || prefs.sortField === "size";
  const { entries, listQuery } = useFileList({
    currentPath,
    includeStats,
    enabled: isAuthed,
    initialData: initialEntries ?? undefined,
  });
  const actions = useFileActions({ currentPath, includeStats });
  const { recordVisit } = actions;
  useEffect(() => {
    if (isAuthed && currentPath) void recordVisit(currentPath);
  }, [currentPath, isAuthed, recordVisit]);

  const sortedEntries = useMemo(() => {
    const sorted = [...entries].sort((a, b) => {
      // When grouping, always sort folders first
      if (prefs.groupByType && a.type !== b.type) {
        return a.type === "dir" ? -1 : 1;
      }

      let comparison = 0;
      switch (prefs.sortField) {
        case "name":
          comparison = a.name.localeCompare(b.name);
          break;
        case "type":
          comparison = a.type.localeCompare(b.type);
          break;
        case "modified":
          comparison = (a.mtime ?? 0) - (b.mtime ?? 0);
          break;
        case "size":
          comparison = (a.size ?? 0) - (b.size ?? 0);
          break;
        default:
          comparison = 0;
      }

      return prefs.sortDirection === "desc" ? -comparison : comparison;
    });
    return sorted;
  }, [entries, prefs.groupByType, prefs.sortDirection, prefs.sortField]);

  const sections = useMemo(
    () =>
      prefs.groupByType
        ? [
            { title: "Folders", entries: sortedEntries.filter((e) => e.type === "dir") },
            { title: "Files", entries: sortedEntries.filter((e) => e.type !== "dir") },
          ]
        : [{ title: "", entries: sortedEntries }],
    [prefs.groupByType, sortedEntries],
  );
  // While the next folder loads, the previous folder stays on screen. Keep restoring and saving
  // scroll positions for the folder actually shown.
  const [shownPath, setShownPath] = useState(currentPath);
  if (!listQuery.isPlaceholderData && shownPath !== currentPath)
    setShownPath(currentPath);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [selectionSlot, setSelectionSlot] = useState<HTMLDivElement | null>(null);

  return (
    <>
      <div
        ref={(element) => {
          toolbarRef.current = element;
          setSelectionSlot(element);
        }}
        className="surface-grain sticky top-16 z-10 -mx-4 -mt-6 mb-6 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border/70 bg-background px-4 py-3 md:-mx-6 md:flex md:justify-between md:px-6 lg:-mx-8 lg:-mt-8 lg:px-8">
        <div className="min-w-0 overflow-hidden">
          <FileBreadcrumbs pathSegments={effectiveSegments} />
        </div>
        <FiltersRow
          prefs={prefs}
          view={view}
          updatePreferences={updatePreferences}
        />
      </div>

      {!session ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="mb-6 flex size-20 items-center justify-center rounded-full bg-primary/10">
            <HardDrive className="size-10 text-primary" />
          </div>
          <h2 className="text-balance text-xl font-semibold">
            Welcome to Nimbus Drive
          </h2>
          <p className="text-pretty mt-2 max-w-md text-sm text-muted-foreground">
            Sign in to access your files, photos, and documents from anywhere.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {listQuery.isLoading ? (
            <LoadingSkeleton view={view} />
          ) : listQuery.isError ? (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
              {listQuery.error instanceof Error
                ? listQuery.error.message
                : "Failed to load files."}
            </div>
          ) : entries.length > 0 ? (
            <EntriesView
              view={view}
              sections={sections}
              actions={actions}
              restoreKey={`${shownPath}:${view}`}
              label={effectiveSegments.at(-1) ?? "My Drive"}
              toolbarRef={toolbarRef}
              selectionSlot={selectionSlot}
            />
          ) : (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="mb-4 flex size-16 items-center justify-center rounded-full bg-muted">
                <Folder className="size-8 text-muted-foreground" />
              </div>
              <h3 className="text-balance text-lg font-medium">
                This folder is empty
              </h3>
              <p className="text-pretty mt-1 text-sm text-muted-foreground">
                Drop files here or use the New button to add content
              </p>
            </div>
          )}
        </div>
      )}
    </>
  );
}
