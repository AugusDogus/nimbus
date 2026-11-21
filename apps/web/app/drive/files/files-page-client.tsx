import { Folder, HardDrive } from "lucide-react";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { trpcErrorCode } from "@/lib/trpc-error";

import { FileBreadcrumbs } from "./breadcrumbs";
import { capabilitiesQueryOptions } from "./capabilities";
import { EntriesView } from "./entries-view";
import { FolderError } from "./folder-error";
import { FiltersRow } from "./filters-row";
import { useFolderPath } from "./folder-path";
import { FolderNotFound } from "./folder-not-found";
import { LoadingSkeleton } from "./loading-skeleton";
import { fileHref } from "./types";
import { useEntryDialog } from "./use-entry-dialog";
import { useFileActions } from "./use-file-actions";
import { useFileList } from "./use-file-list";
import { WebMcpFileTools } from "./webmcp-tools";
import { useFilePreferences } from "./use-file-preferences";

export function FilesPageClient() {
  const currentPath = useFolderPath();
  const effectiveSegments = useMemo(
    () => (currentPath ? currentPath.split("/") : []),
    [currentPath],
  );
  const { session } = useRouteContext({ from: "/_authed" });
  const isAuthed = Boolean(session);

  const { prefs, updatePreferences } = useFilePreferences(isAuthed);
  const view = prefs.view;

  const includeStats =
    prefs.sortField === "modified" || prefs.sortField === "size";
  const { entries, listQuery } = useFileList({
    currentPath,
    includeStats,
    enabled: isAuthed,
  });
  const capabilities = useQuery({
    ...capabilitiesQueryOptions(currentPath),
    enabled: isAuthed,
  });
  const actions = useFileActions({ currentPath, includeStats });
  const { recordVisit } = actions;
  const { selection: dialog, select: onDialog } = useEntryDialog(
    currentPath,
    recordVisit,
  );
  const navigate = useNavigate();
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
            {
              title: "Folders",
              entries: sortedEntries.filter((e) => e.type === "dir"),
            },
            {
              title: "Files",
              entries: sortedEntries.filter((e) => e.type !== "dir"),
            },
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
  const [selectionSlot, setSelectionSlot] = useState<HTMLDivElement | null>(
    null,
  );

  // A folder that is missing or cannot be opened replaces the page, until a listing exists.
  if (listQuery.isError && !listQuery.data)
    return trpcErrorCode(listQuery.error) === "NOT_FOUND" ? (
      <FolderNotFound />
    ) : (
      <FolderError reset={() => void listQuery.refetch()} />
    );

  return (
    <>
      <div
        ref={(element) => {
          toolbarRef.current = element;
          setSelectionSlot(element);
        }}
        className="surface-grain sticky top-16 z-10 -mx-4 -mt-6 mb-6 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border/70 bg-background px-4 py-3 md:-mx-6 md:flex md:justify-between md:px-6 lg:-mx-8 lg:-mt-8 lg:px-8"
      >
        <div className="min-w-0 overflow-hidden pointer-coarse:-my-3 pointer-coarse:py-3 max-lg:pointer-coarse:-ml-3.5 max-lg:pointer-coarse:pl-3.5">
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
          <WebMcpFileTools
            currentPath={currentPath}
            entries={sortedEntries}
            loading={listQuery.isPending || shownPath !== currentPath}
            openFolder={(path) => void navigate({ href: fileHref(path) })}
            openDialog={onDialog}
            createFolder={actions.createFolder}
          />
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
              dialog={dialog}
              onDialog={onDialog}
              stale={shownPath !== currentPath}
            />
          ) : (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="mb-4 flex size-16 items-center justify-center rounded-full bg-muted">
                <Folder className="size-8 text-muted-foreground" />
              </div>
              <h3 className="text-balance text-lg font-medium">
                This folder is empty
              </h3>
              {/* Suggests adding only once the folder is known to take it. Files can be dropped
                  in only with a mouse or trackpad; touch alone cannot drag them. */}
              {capabilities.data?.canWrite === true ? (
                <p className="text-pretty mt-1 text-sm text-muted-foreground">
                  <span className="hidden any-pointer-fine:inline">
                    Drop files here or use the New button to add content
                  </span>
                  <span className="any-pointer-fine:hidden">
                    Tap New to upload files or create a folder
                  </span>
                </p>
              ) : capabilities.data?.canWrite === false ? (
                <p className="text-pretty mt-1 text-sm text-muted-foreground">
                  You can view this folder but not add to it.
                </p>
              ) : null}
            </div>
          )}
        </div>
      )}
    </>
  );
}
