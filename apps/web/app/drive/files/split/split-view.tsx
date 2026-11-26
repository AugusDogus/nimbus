import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { UserPreferences } from "@nimbus/api/context";
import { useUploads } from "@/components/upload-provider";
import { trpc } from "@/lib/trpc";
import { collectDrop } from "@/lib/upload-sources";
import { BreadcrumbTrail } from "../breadcrumb-trail";
import { capabilitiesQueryOptions } from "../capabilities";
import { TransferDialog } from "../entry-dialogs";
import {
  FolderPane,
  type PaneFrame,
  type PanePrefs,
} from "../files-page-client";
import {
  SplitFrameStore,
  type SplitFrame,
  type SplitMode,
} from "../split-frame";
import { NavPlace } from "../nav-place";
import { PaneLinks } from "../pane-links";
import {
  SplitLayout,
  type OtherPane,
  type PaneSide,
  type SplitControl,
} from "../split-layout";
import { fileHref } from "../types";
import {
  useClashChoices,
  useClashHandoff,
  useEntryDialog,
} from "../use-entry-dialog";
import { useFileActions } from "../use-file-actions";
import { useFileDrag } from "../use-file-drag";
import { useFilePreferences } from "../use-file-preferences";
import { renderOtherPaneActions } from "./other-pane-actions";
import { PaneDivider } from "./pane-divider";
import { PaneHistory } from "./pane-history";
import {
  CollapsedPane,
  PaneFailureView,
  PaneTools,
  paneCard,
  type PaneMoves,
} from "./pane-section";
import { SplitAddress } from "./split-address";
import { SplitMemory } from "./split-memory";
import { SplitRoom } from "../split-room";
import { useSidebarFold } from "./split-page";
import { useSwipePanes } from "./swipe-panes";
import { ActivePane } from "./active-pane";
import { EdgeLabel } from "./edge-label";
import { AppFrame } from "@/components/app-frame";

const { minPaneWidth, dividerWidth } = SplitRoom;

const parentOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

/** What folding the sidebar away gives the page, in pixels. */
const sidebarSpare = AppFrame.sidebarRem * 16;

const columns = (ratio: number, collapsed: PaneSide | null) =>
  collapsed === "left"
    ? "2.75rem minmax(0, 1fr)"
    : collapsed === "right"
      ? "minmax(0, 1fr) 2.75rem"
      : `minmax(0, ${ratio}fr) ${dividerWidth}px minmax(0, ${100 - ratio}fr)`;

/**
 * The width of the page's content area, measured: it decides whether the panes fit side by side.
 * The panes fill the area's height, each scrolling on its own below its header.
 */
function useContentWidth(frame: HTMLDivElement | null) {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const area = frame?.parentElement;
    if (!area) return;
    // Inside its padding: on phones the area pads the folder from the window's edges.
    const measure = () => {
      const style = getComputedStyle(area);
      setWidth(
        area.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    return () => observer.disconnect();
  }, [frame]);
  return width;
}

export { openSplit } from "./open-split";

type ControllerProps = {
  left: string;
  layout: SplitLayout;
  /** The page's folder frame, which the panes fill and the divider sizes. */
  frameRef: RefObject<HTMLDivElement | null>;
  /**
   * The frame itself, once it is on the page. A controller can mount in the same update as the
   * page, before the frame is attached; it measures the frame when this arrives.
   */
  frame: HTMLDivElement | null;
};

/**
 * Which pane is active is left out: `ActivePane` carries it to what marks it, so switching panes
 * renders neither the controller nor the panes' listings.
 */
const sameProps = (a: ControllerProps, b: ControllerProps) =>
  a.left === b.left &&
  a.frameRef === b.frameRef &&
  a.frame === b.frame &&
  a.layout.right === b.layout.right &&
  a.layout.ratio === b.layout.ratio &&
  a.layout.collapsed === b.layout.collapsed;

/**
 * Two folders side by side, as the address describes them (see `SplitLayout`). Each pane keeps
 * its own folder, selection, scroll position, sort, view and Back; one drag spans both, so items
 * move between them (or copy, with Ctrl or Option held). Where the panes do not fit, the active
 * pane shows alone and offers the other folder as a destination.
 *
 * It renders nothing itself: after each render it publishes the frame's parts (see `SplitFrame`),
 * and the page puts them around the folder it already shows, which stays mounted. It renders
 * again only when the address or its own state changes, never because it published.
 */
export const SplitController = memo(function SplitController({
  left,
  layout,
  frameRef,
  frame: frameElement,
}: ControllerProps) {
  const navigate = useNavigate();
  // The session alone: the route's context is rebuilt on every navigation, which would render
  // this again each time, even for a change of the active pane.
  const session = useRouteContext({
    from: "/_authed",
    select: (context) => context.session,
  });
  const isAuthed = Boolean(session);
  const top = useQuery({ ...trpc.access.me.queryOptions(), enabled: isAuthed })
    .data?.top;
  const accountPrefs = useFilePreferences(isAuthed);
  const [rightPrefs, setRightPrefs] = useState<UserPreferences>(
    () => SplitMemory.read().prefs ?? accountPrefs.prefs,
  );
  const paths = useMemo(
    () => ({ left, right: layout.right }),
    [left, layout.right],
  );
  // Moves made by dragging act from the pane the address names; the panes' own actions, from
  // their own folders.
  const activePath = paths[layout.active];

  // Callbacks run after later renders, such as from a toast or a drag, and read the address now,
  // with the active pane as shown (see `ActivePane`), which the address may not have caught up to.
  const latest = useRef({ left, layout });
  useLayoutEffect(() => {
    latest.current = { left, layout };
  });
  const go = useCallback(
    (change: Partial<SplitLayout>, leftPath?: string, replace = false) => {
      const now = latest.current;
      void navigate({
        href: SplitAddress.href(leftPath ?? now.left, {
          ...now.layout,
          active: ActivePane.get() ?? now.layout.active,
          ...change,
        }),
        replace,
      });
    },
    [navigate],
  );
  /** Shows `path` in a pane, which becomes the active one; a new history entry. */
  const openIn = useCallback(
    (side: PaneSide, path: string) =>
      side === "left"
        ? go({ active: "left" }, path)
        : go({ active: "right", right: path }),
    [go],
  );
  /**
   * Makes `side` the active pane: shown at once, then recorded in the address in a task of its
   * own, so the frame that shows it does not wait for the router. Nothing is written when the
   * address has it already, read from the window, which has it before this controller would, or
   * when another pane was chosen meanwhile.
   */
  const activate = useCallback(
    (side: PaneSide) => {
      ActivePane.set(side);
      const record = () => {
        if (
          ActivePane.get() === side &&
          SplitAddress.here()?.layout.active !== side
        )
          go({ active: side }, undefined, true);
      };
      if ("requestIdleCallback" in window)
        requestIdleCallback(record, { timeout: 300 });
      else setTimeout(record, 0);
    },
    [go],
  );
  /** Ends the split, keeping `side`'s folder as the page's one folder. */
  const keepOnly = useCallback(
    (side: PaneSide) => {
      const now = latest.current;
      void navigate({
        href: fileHref(SplitLayout.pathOf(now.left, now.layout, side)),
      });
    },
    [navigate],
  );

  useEffect(() => {
    SplitMemory.write({ right: layout.right, ratio: layout.ratio });
  }, [layout.right, layout.ratio]);
  const panePrefs = useMemo<Record<PaneSide, PanePrefs>>(
    () => ({
      left: accountPrefs,
      right: {
        prefs: rightPrefs,
        updatePreferences: (partial) =>
          setRightPrefs((current) => {
            const next = { ...current, ...partial };
            SplitMemory.write({ prefs: next });
            return next;
          }),
      },
    }),
    [accountPrefs, rightPrefs],
  );

  // Each pane's own Back, beside the browser's.
  const [history, setHistory] = useState(() => PaneHistory.start(paths));
  const advanced = PaneHistory.advance(history, paths);
  if (advanced !== history) setHistory(advanced);

  const capabilities = {
    left: useQuery({ ...capabilitiesQueryOptions(left), enabled: isAuthed }),
    right: useQuery({
      ...capabilitiesQueryOptions(layout.right),
      enabled: isAuthed,
    }),
  };
  const labelOf = (path: string) => {
    const trail = BreadcrumbTrail.of(path, top ?? "", NavPlace.labels.files);
    return trail.crumbs.at(-1)?.label ?? trail.root.label;
  };
  const others: Record<PaneSide, OtherPane> = {
    left: {
      path: layout.right,
      label: labelOf(layout.right),
      side: "right",
      writable: capabilities.right.data?.canWrite === true,
    },
    right: {
      path: left,
      label: labelOf(left),
      side: "left",
      writable: capabilities.left.data?.canWrite === true,
    },
  };

  // Moves and copies made by dragging, in a pane or between them. Their name clashes open the
  // picker here; the panes' own actions handle their menus and selection bars.
  const clashHandoff = useClashHandoff();
  const actions = useFileActions({
    currentPath: activePath,
    includeStats: false,
    onClashes: clashHandoff.onClashes,
  });
  const {
    selection: dialog,
    select: onDialog,
    offer,
  } = useEntryDialog("split", actions.recordVisit);
  useClashChoices(clashHandoff, offer);
  const upload = useUploads();
  const drag = useFileDrag({
    moveEntries: actions.moveEntries,
    copyEntries: actions.copyEntries,
    uploadInto: (transfer, path) => {
      if (!session) return;
      void collectDrop(transfer).then((collected) =>
        upload.uploadFiles(collected, { path, userId: session.user.id }),
      );
    },
  });

  const width = useContentWidth(frameElement);
  const [owner] = useState(() => Symbol("split controller"));
  const fits = width !== null && SplitRoom.fits(width);
  // Short of roomy, folding the sidebar gives the panes room: it makes them fit, or wider.
  const foldHelps =
    width !== null &&
    width < SplitRoom.roomy &&
    SplitRoom.fits(width + sidebarSpare);
  const sidebar = useSidebarFold(foldHelps);
  // While the sidebar folds, the panes stay side by side as the room for them grows.
  const sideBySide = fits || (foldHelps && sidebar.foldedForSplit);
  const mode: SplitMode = sideBySide ? "side-by-side" : "swipe";
  useSwipePanes(mode === "swipe" ? frameElement : null, activate);
  // Which pane a drag is over: that pane says where the drag would drop.
  const [dragOver, setDragOver] = useState<PaneSide | null>(null);
  if (drag.state.status !== "dragging" && dragOver !== null) setDragOver(null);
  const usable = width === null ? 0 : width - dividerWidth;
  const bound =
    usable > 0
      ? Math.min(50, Math.ceil((minPaneWidth / usable) * 100))
      : SplitLayout.ratioBounds.min;
  const ratio = Math.min(100 - bound, Math.max(bound, layout.ratio));
  const ids = { left: useId(), right: useId() };

  const focusPane = useCallback(
    (side: PaneSide) => {
      const pane = document.querySelector(`[data-pane="${side}"]`);
      const target =
        pane?.querySelector<HTMLElement>('[data-entry-path][tabindex="0"]') ??
        pane?.querySelector<HTMLElement>("a[href], button:not(:disabled)");
      if (target) target.focus();
      else activate(side);
    },
    [activate],
  );

  // A folder opened in a pane makes that pane active and leaves the other as it is.
  const links = useMemo<Record<PaneSide, PaneLinks>>(
    () => ({
      left: SplitAddress.paneLinks({ left, layout }, "left"),
      right: SplitAddress.paneLinks({ left, layout }, "right"),
    }),
    [left, layout],
  );

  const controlFor = (side: PaneSide): SplitControl => ({
    kind: "open",
    close: () => keepOnly(ActivePane.get() ?? latest.current.layout.active),
    openInOther: (path) => openIn(SplitLayout.other(side), path),
    // Beside this pane, or a swipe away, where focus going there brings it into view; not while
    // folded away.
    focusOther:
      !sideBySide || layout.collapsed === null
        ? () => focusPane(SplitLayout.other(side))
        : null,
  });
  const movesFor = (side: PaneSide): PaneMoves => {
    const path = paths[side];
    const back = PaneHistory.back(history, side);
    const topPath = top ?? "";
    return {
      back: back === null ? null : () => openIn(side, back),
      up:
        path === topPath || path === ""
          ? null
          : () => openIn(side, parentOf(path)),
      top: () => openIn(side, topPath),
    };
  };
  const frameFor = (side: PaneSide): PaneFrame => {
    const moves = movesFor(side);
    return {
      id: ids[side],
      side,
      drag,
      prefs: panePrefs[side],
      moves,
      card: (highlighted, active) => paneCard(side, active, highlighted, mode),
      tools: (
        <PaneTools
          prefs={panePrefs[side]}
          onClose={() => keepOnly(SplitLayout.other(side))}
          // One pane at a time, there is nothing to fold away.
          onCollapse={
            sideBySide
              ? () =>
                  go(
                    { collapsed: side, active: SplitLayout.other(side) },
                    undefined,
                    true,
                  )
              : null
          }
        />
      ),
      failure: (failure) => <PaneFailureView failure={failure} moves={moves} />,
      edge: sideBySide
        ? null
        : (folder) => (
            <EdgeLabel
              side={side}
              name={folder.name}
              count={folder.count}
              onShow={() => ActivePane.set(side)}
            />
          ),
      onActivate: () => activate(side),
      onPress: sideBySide ? () => activate(side) : null,
      dragOver: dragOver === side,
      onDragOver: () => {
        if (dragOver !== side) setDragOver(side);
      },
    };
  };

  const paneFor = (side: PaneSide) => ({
    kind: "folder" as const,
    path: paths[side],
    pane: frameFor(side),
    other: others[side],
    control: controlFor(side),
    links: links[side],
  });
  const collapsed = (side: PaneSide) => (
    <CollapsedPane
      key={side}
      side={side}
      label={labelOf(paths[side])}
      onExpand={() => go({ collapsed: null }, undefined, true)}
    />
  );
  const right = (
    <PaneLinks.Provider value={links.right}>
      <FolderPane
        key="right"
        path={paths.right}
        pane={frameFor("right")}
        other={others.right}
        split={controlFor("right")}
      />
    </PaneLinks.Provider>
  );
  // One pane at a time, a swipe or the other pane's edge apart: both folders stay reachable, whichever
  // pane a wider screen had folded away.
  const rest = !sideBySide ? (
    right
  ) : layout.collapsed === "right" ? (
    collapsed("right")
  ) : (
    <>
      {layout.collapsed === null && (
        <PaneDivider
          ratio={ratio}
          min={bound}
          max={100 - bound}
          frameRef={frameRef}
          controls={ids.left}
          preview={(next) => {
            frameRef.current?.style.setProperty(
              "grid-template-columns",
              columns(next, null),
            );
          }}
          commit={(next) => {
            frameRef.current?.style.setProperty(
              "grid-template-columns",
              columns(next, null),
            );
            go({ ratio: next }, undefined, true);
          }}
        />
      )}
      {right}
    </>
  );
  const frame: SplitFrame | null =
    width === null
      ? null
      : {
          mode,
          style: sideBySide
            ? {
                gridTemplateColumns: columns(ratio, layout.collapsed),
                // A folded pane's card keeps the gap the divider leaves.
                columnGap: layout.collapsed ? dividerWidth : 0,
              }
            : undefined,
          first: !sideBySide
            ? paneFor("left")
            : layout.collapsed === "left"
              ? { kind: "collapsed", element: collapsed("left") }
              : paneFor("left"),
          rest,
          extras: (
            <>
              {sideBySide && drag.state.status === "moving" && (
                <p role="status" className="sr-only">
                  {drag.state.operation === "copy" ? "Copying" : "Moving"}{" "}
                  {drag.state.sources.length === 1
                    ? drag.state.sources[0]?.name
                    : `${drag.state.sources.length} items`}
                  …
                </p>
              )}
              <TransferDialog
                dialog={dialog}
                actions={actions}
                onClose={() => onDialog(null)}
              />
            </>
          ),
          otherPaneActions: {
            render: renderOtherPaneActions,
            prominent: !sideBySide,
          },
        };
  // After every render: the page shows this frame until the next one, or none once closed.
  useLayoutEffect(() => {
    SplitFrameStore.set(frame, owner);
  });
  // Clears only its own frame: a controller that has already replaced it, such as the next
  // page's when a pane opens the drive root, keeps showing.
  useLayoutEffect(() => () => SplitFrameStore.clear(owner), [owner]);
  return null;
}, sameProps);
