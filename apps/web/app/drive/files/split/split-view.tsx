import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import {
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
import { OtherPaneActionsSlot } from "../selection-bar";
import { renderOtherPaneActions } from "./other-pane-actions";
import { PaneDivider } from "./pane-divider";
import { PaneHistory } from "./pane-history";
import {
  CollapsedPane,
  PaneChrome,
  PaneSection,
  type PaneMoves,
} from "./pane-section";
import { SplitAddress } from "./split-address";
import { SplitMemory } from "./split-memory";
import { usePageArea } from "./split-page";

/** Narrowest useful pane, in pixels. */
const minPaneWidth = 420;
/** The gap between the two pane cards, which is the divider. */
const dividerWidth = 8;
/** Below this width of the page's content area the panes do not fit side by side. */
const minSideBySide = 900;

const parentOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

const columns = (ratio: number, collapsed: PaneSide | null) =>
  collapsed === "left"
    ? "2.75rem minmax(0, 1fr)"
    : collapsed === "right"
      ? "minmax(0, 1fr) 2.75rem"
      : `minmax(0, ${ratio}fr) ${dividerWidth}px minmax(0, ${100 - ratio}fr)`;

type Box = { width: number; height: number };

/**
 * The page's content area, measured: its width decides whether the panes fit side by side, and
 * its height is what the panes fill, each scrolling on its own below the page header.
 */
function useContentBox(frame: RefObject<HTMLDivElement | null>) {
  const [box, setBox] = useState<Box | null>(null);
  useLayoutEffect(() => {
    const area = frame.current?.parentElement;
    const scroller = area?.closest<HTMLElement>('[data-slot="sidebar-inset"]');
    if (!area || !scroller) return;
    const header = scroller.querySelector<HTMLElement>(":scope > header");
    const measure = () => {
      const style = getComputedStyle(scroller);
      const height =
        scroller.clientHeight -
        parseFloat(style.paddingTop) -
        parseFloat(style.paddingBottom) -
        (header?.offsetHeight ?? 0);
      const next = { width: area.clientWidth, height: Math.max(0, height) };
      setBox((current) =>
        current?.width === next.width && current.height === next.height
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [frame]);
  return box;
}

/**
 * Two folders side by side, as the address describes them (see `SplitLayout`). Each pane keeps
 * its own folder, selection, scroll position, sort, view and Back; one drag spans both, so items
 * move between them (or copy, with Ctrl or Option held). Where the panes do not fit, the active
 * pane shows alone and offers the other folder as a destination.
 */
export default function SplitView({
  left,
  layout,
}: {
  left: string;
  layout: SplitLayout;
}) {
  const navigate = useNavigate();
  const { session } = useRouteContext({ from: "/_authed" });
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
  const activePath = paths[layout.active];

  // Callbacks run after later renders, such as from a toast or a drag, and read the address now.
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
  const activate = useCallback(
    (side: PaneSide) => {
      if (latest.current.layout.active !== side)
        go({ active: side }, undefined, true);
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

  const frameRef = useRef<HTMLDivElement>(null);
  const box = useContentBox(frameRef);
  const sideBySide = box !== null && box.width >= minSideBySide;
  usePageArea(frameRef, sideBySide);
  // Which pane a drag is over: that pane says where the drag would drop.
  const [dragOver, setDragOver] = useState<PaneSide | null>(null);
  if (drag.state.status !== "dragging" && dragOver !== null) setDragOver(null);
  const usable = box ? box.width - dividerWidth : 0;
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
    close: () => keepOnly(latest.current.layout.active),
    openInOther: (path) => openIn(SplitLayout.other(side), path),
    focusOther:
      sideBySide && layout.collapsed === null
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
  const frameFor = (side: PaneSide): PaneFrame => ({
    side,
    active: layout.active === side,
    drag,
    prefs: panePrefs[side],
    Frame: PaneSection,
  });
  const chromeFor = (side: PaneSide): PaneChrome => ({
    id: ids[side],
    side,
    active: layout.active === side,
    drag,
    moves: movesFor(side),
    onClose: () => keepOnly(SplitLayout.other(side)),
    dragOver: dragOver === side,
    onDragOver: () => setDragOver(side),
    onActivate: () => activate(side),
  });

  const pane = (side: PaneSide) =>
    layout.collapsed === side ? (
      <CollapsedPane
        key={side}
        side={side}
        label={labelOf(paths[side])}
        onReopen={() => go({ collapsed: null }, undefined, true)}
      />
    ) : (
      <PaneLinks.Provider key={side} value={links[side]}>
        <PaneChrome.Provider value={chromeFor(side)}>
          <FolderPane
            path={paths[side]}
            pane={frameFor(side)}
            other={others[side]}
            split={controlFor(side)}
          />
        </PaneChrome.Provider>
      </PaneLinks.Provider>
    );

  return (
    <OtherPaneActionsSlot.Provider value={renderOtherPaneActions}>
      {box === null ? (
        <div ref={frameRef} />
      ) : sideBySide ? (
        <div
          ref={frameRef}
          data-split-view
          className="-mx-4 -mb-24 -mt-6 grid md:-mx-6 md:-mb-6 lg:-mx-8 lg:-mt-8"
          style={{
            height: box.height,
            gridTemplateColumns: columns(ratio, layout.collapsed),
            // A folded pane's card keeps the gap the divider leaves.
            columnGap: layout.collapsed ? dividerWidth : 0,
          }}
        >
          {pane("left")}
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
              collapse={(side) =>
                go(
                  { collapsed: side, active: SplitLayout.other(side) },
                  undefined,
                  true,
                )
              }
            />
          )}
          {pane("right")}
        </div>
      ) : (
        // One folder fits: the active pane's, with the other offered as a destination.
        <div ref={frameRef} data-split-view="narrow">
          <PaneLinks.Provider value={links[layout.active]}>
            <FolderPane
              key={layout.active}
              path={activePath}
              pane={null}
              other={others[layout.active]}
              split={controlFor(layout.active)}
            />
          </PaneLinks.Provider>
        </div>
      )}
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
    </OtherPaneActionsSlot.Provider>
  );
}
