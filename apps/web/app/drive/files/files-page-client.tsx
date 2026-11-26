import { MoveUp } from "./move-up";
import { Folder, HardDrive } from "lucide-react";
import {
  useCanGoBack,
  useNavigate,
  useRouteContext,
  useRouter,
} from "@tanstack/react-router";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";

import type { UserPreferences } from "@nimbus/api/context";
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
import { FiltersRow, folderFilters } from "./filters-row";
import { useFolderPath } from "./folder-path";
import { FolderNotFound } from "./folder-not-found";
import { NavPlace } from "./nav-place";
import { LoadingSkeleton } from "./loading-skeleton";
import type { DropTarget } from "./drop-target";
import { PaneLinks, usePaneHref } from "./pane-links";
import { OtherPaneActionsSlot } from "./selection-bar";
import { SplitCode, useSplitCode, useSplitFrame } from "./split-frame";
import {
  SplitLayout,
  useSplitLayout,
  type OtherPane,
  type PaneSide,
  type SplitControl,
} from "./split-layout";
import {
  useClashChoices,
  useClashHandoff,
  useEntryDialog,
} from "./use-entry-dialog";
import { useFileActions } from "./use-file-actions";
import { useFileDrag, type FileDrag } from "./use-file-drag";
import { DragHint } from "./drag-hint";
import { useUploads } from "@/components/upload-provider";
import { collectDrop } from "@/lib/upload-sources";
import { useFileList } from "./use-file-list";
import { WebMcpFileTools } from "./webmcp-tools";
import { useFilePreferences } from "./use-file-preferences";
import { AloneFolderTools, openSplit, SplitToggle } from "./split-toggle";
import { HeaderTools } from "./header-tools";
import {
  FolderCard,
  type FolderCardClasses,
  type FolderMoves,
} from "./folder-card";
import { fileHref } from "./types";
import { SplitRoom } from "./split-room";
import { ActivePane } from "./split/active-pane";

export function FilesPageClient() {
  const left = useFolderPath();
  const layout = useSplitLayout();
  const navigate = useNavigate();
  // The address says which pane is active whenever it changes; between, a swipe or a tap has
  // shown its pane first (see `ActivePane`).
  useLayoutEffect(() => {
    ActivePane.set(layout?.active ?? null);
  }, [layout?.active, layout?.right, layout?.ratio, layout?.collapsed, left]);
  const alone = useMemo<SplitControl>(
    () => ({
      kind: "closed",
      open: (right) => openSplit(navigate, left, right),
    }),
    [navigate, left],
  );
  // A split view's controller sits beside the frame and publishes what the frame shows (see
  // `SplitFrame`). Until it has, and once the split closes, the frame shows the one folder.
  const code = useSplitCode(layout !== null);
  const published = useSplitFrame();
  const split = layout && code ? published : null;
  const first = split?.first.kind === "folder" ? split.first : null;
  // The frame as state too: a controller that mounts with the page measures it once it exists.
  const frameRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const attachFrame = useCallback((element: HTMLDivElement | null) => {
    frameRef.current = element;
    setFrame(element);
  }, []);
  // The split view's code loads once a folder page has settled, so the split opens at once.
  useEffect(() => {
    if (SplitRoom.modeOfThisWindow() !== "side-by-side") return;
    const timer = setTimeout(() => {
      if ("requestIdleCallback" in window)
        requestIdleCallback(SplitCode.preload, { timeout: 1000 });
      else SplitCode.preload();
    }, 500);
    return () => clearTimeout(timer);
  }, []);
  return (
    <>
      <HeaderTools>
        <SplitToggle
          open={layout !== null}
          onToggle={() =>
            layout
              ? void navigate({
                  href: fileHref(
                    SplitLayout.pathOf(
                      left,
                      layout,
                      ActivePane.get() ?? layout.active,
                    ),
                  ),
                })
              : openSplit(navigate, left, null)
          }
        />
      </HeaderTools>
      {layout && code && (
        <code.SplitController
          left={left}
          layout={layout}
          frame={frame}
          frameRef={frameRef}
        />
      )}
      <OtherPaneActionsSlot.Provider value={split?.otherPaneActions ?? null}>
        <div
          ref={attachFrame}
          data-split-view={split?.mode}
          className={
            split?.mode === "side-by-side"
              ? "grid min-h-0 flex-1"
              : split?.mode === "swipe"
                ? // One pane at a time: the frame reaches the window's edges and scrolls sideways,
                  // snapping to a pane, and never hands a swipe past its ends to the page. Each
                  // pane leaves the other's edge in view, 56 px, where its name is (`EdgeLabel`):
                  // the first pane snaps to the frame's start, the second to its end.
                  "-mx-4 flex min-h-0 flex-1 snap-x snap-mandatory gap-2 overflow-x-auto overflow-y-hidden overscroll-x-contain px-2 scroll-px-2 [scrollbar-width:none] *:w-[calc(100%-3.5rem)] *:min-w-0 *:shrink-0 *:snap-start [&>*+*]:snap-end"
                : "md:flex md:min-h-0 md:flex-1 md:flex-col"
          }
          style={split?.style}
          // A listing that takes focus can open a split with a key: its code starts loading.
          onFocusCapture={SplitCode.preload}
        >
          {split?.first.kind === "collapsed" ? (
            split.first.element
          ) : (
            <PaneLinks.Provider value={first?.links ?? null}>
              <FolderPane
                path={first?.path ?? left}
                pane={first?.pane ?? null}
                other={first?.other ?? null}
                split={first?.control ?? alone}
              />
            </PaneLinks.Provider>
          )}
          {split?.rest}
        </div>
      </OtherPaneActionsSlot.Provider>
      {split?.extras}
    </>
  );
}

/** A pane's sort, grouping and view, and how to change them. */
export type PanePrefs = {
  prefs: UserPreferences;
  updatePreferences: (partial: Partial<UserPreferences>) => void;
};

/** Why a pane's folder cannot be listed: missing, refused, or another failure to retry. */
export type PaneFailure = {
  code: "NOT_FOUND" | "FORBIDDEN" | null;
  retry: () => void;
};

/**
 * A pane of a split view, given by the split view: which one, the drag both panes share, its own
 * sort and view, its Back and Up, and what its card shows that a page's one folder does not.
 * Whether commands act on it is not here but in `ActivePane`, so switching panes leaves the
 * panes' listings as they are.
 */
export type PaneFrame = {
  id: string;
  side: PaneSide;
  drag: FileDrag;
  prefs: PanePrefs;
  moves: FolderMoves;
  /** After the path in the pane's header: its sort and view menu, and Close. */
  tools: ReactNode;
  /**
   * The pane's card, given whether a drag would drop into its folder and whether it is the
   * active pane (see `FolderCard`).
   */
  card: (
    highlighted: boolean,
    active: boolean,
  ) => { label: string; classes: FolderCardClasses };
  /** Says why the pane's folder cannot be shown, with ways on that keep the pane open. */
  failure: (failure: PaneFailure) => ReactNode;
  /**
   * What the pane's edge shows while the other pane is in view, given its folder's name and how
   * many items it lists (null until listed): one pane at a time, the edge's label; null side by
   * side, where both show.
   */
  edge: ((folder: { name: string; count: number | null }) => ReactNode) | null;
  onActivate: () => void;
  /** Whether a drag is over this pane, which then says where it would drop. */
  dragOver: boolean;
  onDragOver: () => void;
};

/** What only the active pane shows, or the page's one folder (`side` null). */
function WhenActive({
  side,
  children,
}: {
  side: PaneSide | null;
  children: ReactNode;
}) {
  const active = ActivePane.useIs(side);
  return side === null || active ? children : null;
}

const failureCode = (code: string | null | undefined) =>
  code === "NOT_FOUND" || code === "FORBIDDEN" ? code : null;

/**
 * One folder: its toolbar and listing. Alone it is the page, laid out as it always was; in a
 * split view (`pane`) it keeps its own sort, view, selection, scroll position and dialogs, and
 * hands its parts to the pane's frame.
 */
export const FolderPane = memo(function FolderPane({
  path: currentPath,
  pane,
  other,
  split,
}: {
  path: string;
  pane: PaneFrame | null;
  other: OtherPane | null;
  split: SplitControl;
}) {
  // The session alone: the route's context is rebuilt on every navigation, which would render
  // this again each time, even for a change of the active pane.
  const session = useRouteContext({
    from: "/_authed",
    select: (context) => context.session,
  });
  const isAuthed = Boolean(session);
  // The layout loads the account before any folder shows, so the root is right from the start.
  const me = useQuery({ ...trpc.access.me.queryOptions(), enabled: isAuthed });
  const top = me.data?.top ?? "";
  const trail = useMemo(
    () => BreadcrumbTrail.of(currentPath, top, NavPlace.labels.files),
    [currentPath, top],
  );

  const accountPrefs = useFilePreferences(isAuthed);
  const { prefs, updatePreferences } = pane ? pane.prefs : accountPrefs;
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
  // takes nothing from this account; not known while what it allows is loading.
  const parent = capabilities.data?.ancestors.at(-1);
  const moveUp: MoveUp =
    currentPath === top
      ? MoveUp.none
      : capabilities.isPending
        ? MoveUp.unknown
        : parent?.canWrite === true
          ? { kind: "into", path: parent.path }
          : MoveUp.none;
  const clashHandoff = useClashHandoff();
  const actions = useFileActions({
    currentPath,
    includeStats,
    onClashes: clashHandoff.onClashes,
  });
  const upload = useUploads();
  // Files from the computer dropped on a folder go into that folder. A split view's panes share
  // the split's drag instead, so items can go from one pane to the other.
  const ownDrag = useFileDrag({
    moveEntries: actions.moveEntries,
    uploadInto: (transfer, path) => {
      if (!session) return;
      void collectDrop(transfer).then((collected) =>
        upload.uploadFiles(collected, { path, userId: session.user.id }),
      );
    },
  });
  const drag = pane ? pane.drag : ownDrag;
  const { recordVisit } = actions;
  const {
    selection: dialog,
    select: onDialog,
    offer,
  } = useEntryDialog(currentPath, recordVisit);
  useClashChoices(clashHandoff, offer);
  const navigate = useNavigate();
  const folderHref = usePaneHref();
  // Alone, the folder goes back the way the browser does, and up to the folder above it.
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const ownMoves: FolderMoves = {
    back: canGoBack ? () => router.history.back() : null,
    up:
      currentPath === top || currentPath === ""
        ? null
        : () =>
            void navigate({
              href: folderHref(
                currentPath.slice(0, Math.max(0, currentPath.lastIndexOf("/"))),
              ),
            }),
  };
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
  const attachToolbar = (element: HTMLDivElement | null) => {
    toolbarRef.current = element;
    setSelectionSlot(element);
  };

  const breadcrumbs = (
    <FileBreadcrumbs
      trail={trail}
      folded={pane !== null}
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
  );
  // A folder that is missing, refused or cannot be opened replaces the page, until a listing
  // exists. The server refuses a folder the account may not browse before looking it up, so
  // a refusal says nothing about whether it exists. A pane says so at once, even over the
  // listing it showed: its folder went away while the other pane goes on working.
  const code = listQuery.isError ? trpcErrorCode(listQuery.error) : null;
  const failed =
    listQuery.isError &&
    (!listQuery.data || (pane !== null && failureCode(code) !== null));
  if (failed && !pane)
    return code === "NOT_FOUND" ? (
      <FolderNotFound />
    ) : code === "FORBIDDEN" ? (
      <FolderForbidden />
    ) : (
      <FolderError reset={() => void listQuery.refetch()} />
    );

  const body = !session ? (
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
      {/* Page tools act on one folder: the active pane's in a split view. */}
      <WhenActive side={pane?.side ?? null}>
        <WebMcpFileTools
          currentPath={currentPath}
          entries={sortedEntries}
          loading={listQuery.isPending || shownPath !== currentPath}
          openFolder={(path) => void navigate({ href: folderHref(path) })}
          openDialog={onDialog}
          createFolder={actions.createFolder}
        />
      </WhenActive>
      {/* Such a folder lists only what leads to grants inside it; it is not empty or partial. */}
      {listQuery.data && capabilities.data?.canRead === false && (
        <p role="note" className="text-pretty text-sm text-muted-foreground">
          Only folders leading to items shared with you are shown.
        </p>
      )}
      <TransferDialog
        dialog={dialog}
        actions={actions}
        onClose={() => onDialog(null)}
        pinned={
          other
            ? [{ label: `Other pane: ${other.label}`, path: other.path }]
            : []
        }
      />
      {listQuery.isLoading ? (
        <LoadingSkeleton view={view} delayMs={150} />
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
          // The right pane keeps its own positions: both panes may show one folder.
          restoreKey={`${pane?.side === "right" ? "right:" : ""}${shownPath}:${view}`}
          label={trail.crumbs.at(-1)?.label ?? trail.root.label}
          toolbarRef={toolbarRef}
          selectionSlot={selectionSlot}
          dialog={dialog}
          onDialog={onDialog}
          stale={shownPath !== currentPath}
          split={split}
          other={other}
          compact={pane !== null}
          dragHint={pane === null}
        />
      ) : (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          {/* Files from the computer can still be dropped on the breadcrumb's folders. */}
          {!pane && <DragHint drag={drag} />}
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
  );

  // The pane's folder takes drops on its empty space; read-only until its permissions arrive.
  const target: DropTarget = {
    path: currentPath,
    writable: !failed && capabilities.data?.canWrite === true,
  };
  return (
    <FolderCard
      pane={
        pane && {
          id: pane.id,
          side: pane.side,
          card: (active) =>
            pane.card(drag.dropState(target.path) === "allowed", active),
          handlers: {
            onPointerDownCapture: pane.onActivate,
            onFocusCapture: pane.onActivate,
            onDragOverCapture: pane.onDragOver,
            ...drag.targetProps(target),
          },
          hint: (
            <>
              <DragHint drag={drag} placement="pane" shown={pane.dragOver} />
              {pane.edge?.({
                name: trail.crumbs.at(-1)?.label ?? trail.root.label,
                count: listQuery.data ? entries.length : null,
              })}
            </>
          ),
        }
      }
      attachToolbar={attachToolbar}
      moves={pane ? pane.moves : ownMoves}
      breadcrumbs={breadcrumbs}
      tools={
        pane ? (
          pane.tools
        ) : split.kind === "closed" ? (
          <AloneFolderTools
            filters={folderFilters(prefs, updatePreferences)}
            onSplit={() => split.open(null)}
          />
        ) : (
          <FiltersRow {...folderFilters(prefs, updatePreferences)} />
        )
      }
      body={
        failed && pane
          ? pane.failure({
              code: failureCode(code),
              retry: () => void listQuery.refetch(),
            })
          : body
      }
    />
  );
});
