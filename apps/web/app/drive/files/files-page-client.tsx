import { Folder, HardDrive } from "lucide-react";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { trpc } from "@/lib/trpc";
import { trpcErrorCode } from "@/lib/trpc-error";

import { BreadcrumbTrail } from "./breadcrumb-trail";
import { FileBreadcrumbs } from "./breadcrumbs";
import { capabilitiesQueryOptions } from "./capabilities";
import { TransferDialog } from "./entry-dialogs";
import { EntriesView } from "./entries-view";
import { sortEntries } from "./entry-sort";
import { FolderError } from "./folder-error";
import { FolderForbidden } from "./folder-forbidden";
import { FiltersRow } from "./filters-row";
import { useFolderPath } from "./folder-path";
import { FolderNotFound } from "./folder-not-found";
import { NavPlace } from "./nav-place";
import { LoadingSkeleton } from "./loading-skeleton";
import { fileHref } from "./types";
import {
  useClashChoices,
  useClashHandoff,
  useEntryDialog,
} from "./use-entry-dialog";
import { useFileActions } from "./use-file-actions";
import { useFileDrag } from "./use-file-drag";
import { DragHint } from "./drag-hint";
import { useUploads } from "@/components/upload-provider";
import { collectDrop } from "@/lib/upload-sources";
import { useFileList } from "./use-file-list";
import { WebMcpFileTools } from "./webmcp-tools";
import { useFilePreferences } from "./use-file-preferences";

export function FilesPageClient() {
  const currentPath = useFolderPath();
  const { session } = useRouteContext({ from: "/_authed" });
  const isAuthed = Boolean(session);
  // The layout loads the account before any folder shows, so the root is right from the start.
  const me = useQuery({ ...trpc.access.me.queryOptions(), enabled: isAuthed });
  const top = me.data?.top ?? "";
  const trail = useMemo(
    () => BreadcrumbTrail.of(currentPath, top, NavPlace.labels.files),
    [currentPath, top],
  );

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
  // Items move up into the folder above, unless this is the account's top folder or that folder
  // takes nothing from this account.
  const parent = capabilities.data?.ancestors.at(-1);
  const moveUp =
    currentPath !== top && parent?.canWrite === true ? parent.path : null;
  const clashHandoff = useClashHandoff();
  const actions = useFileActions({
    currentPath,
    includeStats,
    onClashes: clashHandoff.onClashes,
  });
  const upload = useUploads();
  // Files from the computer dropped on a folder go into that folder.
  const drag = useFileDrag({
    moveEntries: actions.moveEntries,
    uploadInto: (transfer, path) => {
      if (!session) return;
      void collectDrop(transfer).then((collected) =>
        upload.uploadFiles(collected, { path, userId: session.user.id }),
      );
    },
  });
  const { recordVisit } = actions;
  const {
    selection: dialog,
    select: onDialog,
    offer,
  } = useEntryDialog(currentPath, recordVisit);
  useClashChoices(clashHandoff, offer);
  const navigate = useNavigate();
  useEffect(() => {
    if (isAuthed && currentPath) void recordVisit(currentPath);
  }, [currentPath, isAuthed, recordVisit]);

  const sortedEntries = useMemo(
    () => sortEntries(entries, prefs),
    [entries, prefs],
  );

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

  // A folder that is missing, refused or cannot be opened replaces the page, until a listing
  // exists. The server refuses a folder the account may not browse before looking it up, so
  // a refusal says nothing about whether it exists.
  if (listQuery.isError && !listQuery.data) {
    const code = trpcErrorCode(listQuery.error);
    return code === "NOT_FOUND" ? (
      <FolderNotFound />
    ) : code === "FORBIDDEN" ? (
      <FolderForbidden />
    ) : (
      <FolderError reset={() => void listQuery.refetch()} />
    );
  }

  return (
    <>
      <div
        ref={(element) => {
          toolbarRef.current = element;
          setSelectionSlot(element);
        }}
        className="surface-grain sticky top-16 z-10 -mx-4 -mt-6 mb-6 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border/70 bg-background px-4 py-3 md:-mx-6 md:flex md:justify-between md:px-6 lg:-mx-8 lg:-mt-8 lg:px-8"
      >
        <div className="min-w-0 overflow-hidden pointer-coarse:-my-3 pointer-coarse:py-3 pointer-coarse:-ml-3.5 pointer-coarse:pl-3.5">
          <FileBreadcrumbs
            trail={trail}
            drop={{
              dragging:
                drag.state.status === "dragging" &&
                drag.state.payload.kind === "entries",
              acceptsFiles: true,
              // Unknown until the folder's capabilities arrive, and refused meanwhile.
              writable: (path) =>
                capabilities.data?.ancestors.some(
                  (ancestor) => ancestor.path === path && ancestor.canWrite,
                ) ?? false,
              targetProps: drag.targetProps,
              dropState: drag.dropState,
            }}
          />
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
          {/* Such a folder lists only what leads to grants inside it; it is not empty or partial. */}
          {listQuery.data && capabilities.data?.canRead === false && (
            <p
              role="note"
              className="text-pretty text-sm text-muted-foreground"
            >
              Only folders leading to items shared with you are shown.
            </p>
          )}
          <TransferDialog
            dialog={dialog}
            actions={actions}
            onClose={() => onDialog(null)}
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
              drag={drag}
              moveUp={moveUp}
              restoreKey={`${shownPath}:${view}`}
              label={trail.crumbs.at(-1)?.label ?? trail.root.label}
              toolbarRef={toolbarRef}
              selectionSlot={selectionSlot}
              dialog={dialog}
              onDialog={onDialog}
              stale={shownPath !== currentPath}
            />
          ) : (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              {/* Files from the computer can still be dropped on the breadcrumb's folders. */}
              <DragHint drag={drag} />
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
