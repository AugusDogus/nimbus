import { lazyComponent } from "@/components/lazy-component";
import { useNavigate } from "@tanstack/react-router";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { EntryMenu, EntryMenuHost, type EntryMenuTarget } from "./entry-menu";
import { EntryRow, type EntryRowHandlers } from "./entry-row";
import { EditEntryDialog, type EntryDialog } from "./entry-dialogs";
import { commandFor, typeaheadMatch } from "./entry-keys";
import { EntryLayout, entryGeometry, type EntrySection } from "./entry-layout";
import { PreviewDialog } from "./preview-dialog";
import { Selection } from "./selection";
import { SelectionBar } from "./selection-bar";
import { ShortcutHelp } from "./shortcut-help";
import { fileHref, FileEntry } from "./types";
import type { useFileActions } from "./use-file-actions";
import { useFileDrag } from "./use-file-drag";
import { useGridColumns } from "./use-grid-columns";
import { useVirtualRows } from "./use-virtual-rows";

// Dialogs open on demand; keep them out of the page's first load.
const SharingDialog = lazyComponent(async () => ({
  default: (await import("./sharing-dialog")).SharingDialog,
}));
const VersionsDialog = lazyComponent(() => import("./versions-dialog"));

type Props = {
  view: "list" | "grid";
  sections: readonly EntrySection<FileEntry>[];
  actions: ReturnType<typeof useFileActions>;
  /** Identifies the folder and view whose scroll position is saved and restored. */
  restoreKey: string;
  /** Accessible name of the collection, such as the folder name. */
  label: string;
  /** Sticky toolbar covering the top of the scroll area. */
  toolbarRef?: RefObject<HTMLElement | null>;
  /** Element the selection bar overlays. Without one, the bar floats at the bottom of the screen. */
  selectionSlot?: HTMLElement | null;
  /** Replaces the plain name, e.g. to add search context. Keep it stable so rows stay memoized. */
  renderName?: (entry: FileEntry) => ReactNode;
  /** The open dialog, owned by the page (`useEntryDialog`) so page tools (WebMCP) can open dialogs too. */
  dialog: EntryDialog | null;
  onDialog: (dialog: EntryDialog | null) => void;
  /**
   * The entries are a folder being left while the next one loads. They stay on screen but take
   * no input, and their selection and menu are dropped, so nothing acts on items no longer shown.
   */
  stale?: boolean;
};

const longPressMs = 450;
const isMac = () =>
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.userAgent);

export function EntriesView({
  view,
  sections,
  actions,
  restoreKey,
  label,
  toolbarRef,
  selectionSlot,
  renderName,
  dialog,
  onDialog,
  stale = false,
}: Props) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const columns = useGridColumns();
  const layout = useMemo(
    () => EntryLayout.build(sections, view, view === "grid" ? columns : 1),
    [sections, view, columns],
  );
  const order = useMemo(
    () => Selection.order(layout.entries.map((entry) => entry.path)),
    [layout.entries],
  );
  const names = useMemo(
    () => layout.entries.map((entry) => entry.name),
    [layout.entries],
  );

  const [selection, setSelection] = useState(Selection.empty);
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [touchSelecting, setTouchSelecting] = useState(false);
  // Preview navigation follows the displayed order. Only computed while a preview is open.
  const previewing = dialog?.action === "preview";
  const previewable = useMemo(
    () =>
      previewing ? layout.entries.filter((entry) => entry.type === "file") : [],
    [previewing, layout.entries],
  );
  const [menu, setMenu] = useState<EntryMenu | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  // Entries can leave the folder through live updates, moves, and other clients.
  const retained = Selection.retain(selection, order);
  if (retained !== selection) setSelection(retained);
  if (focusPath !== null && !order.index.has(focusPath)) setFocusPath(null);
  if (touchSelecting && selection.paths.size === 0) setTouchSelecting(false);
  if (stale && selection.paths.size > 0) setSelection(Selection.empty);
  if (stale && menu !== null) setMenu(null);
  const focusIndex =
    focusPath === null ? -1 : (order.index.get(focusPath) ?? -1);

  const containerRef = useRef<HTMLDivElement>(null);
  const fallbackToolbar = useRef<HTMLElement>(null);
  const virtual = useVirtualRows({
    layout,
    containerRef,
    obstructionRef: toolbarRef ?? fallbackToolbar,
    restoreKey,
  });
  const drag = useFileDrag(actions);
  const pendingFocus = useRef<string | null>(null);
  const typeahead = useRef<{
    text: string;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ text: "", timer: null });
  const longPress = useRef<{
    timer: ReturnType<typeof setTimeout>;
    x: number;
    y: number;
  } | null>(null);
  const suppressClick = useRef(false);
  const previewOnRelease = useRef<FileEntry | null>(null);

  const selectedEntries = useMemo(
    () =>
      selection.paths.size === 0
        ? []
        : layout.entries.filter((entry) => selection.paths.has(entry.path)),
    [layout.entries, selection.paths],
  );
  /** What an action on `entry` applies to: the selection when it includes `entry`. */
  const targetsFor = useCallback(
    (entry: FileEntry) =>
      selection.paths.has(entry.path) && selection.paths.size > 1
        ? selectedEntries
        : [entry],
    [selectedEntries, selection.paths],
  );

  const open = (next: EntryDialog) => onDialog(next);

  const focusEntry = (
    index: number,
    mode: "select" | "extend" | "focus" | "toggle",
  ) => {
    const path = order.paths[index];
    if (path === undefined) return;
    setFocusPath(path);
    if (mode === "select") setSelection(Selection.only(path));
    if (mode === "extend")
      setSelection((current) =>
        Selection.range(
          current.anchor === null && focusPath
            ? Selection.only(focusPath)
            : current,
          order,
          path,
          false,
        ),
      );
    if (mode === "toggle")
      setSelection((current) => Selection.toggle(current, path));
    pendingFocus.current = path;
    virtual.revealRow(EntryLayout.rowOf(layout, index));
  };

  // Keyboard moves can target rows that were not mounted yet. Focus them once they render.
  useLayoutEffect(() => {
    const path = pendingFocus.current;
    if (!path) return;
    const element = containerRef.current?.querySelector<HTMLElement>(
      `[data-entry-path="${CSS.escape(path)}"]`,
    );
    if (!element) return;
    pendingFocus.current = null;
    element.focus({ preventScroll: true });
  });

  const activate = (entry: FileEntry) => {
    if (entry.type === "dir") void navigate({ href: fileHref(entry.path) });
    else open({ action: "preview", entry });
  };

  const commandTargets = () => {
    if (selectedEntries.length > 0) return selectedEntries;
    const focused = focusIndex >= 0 ? layout.entries[focusIndex] : undefined;
    return focused ? [focused] : [];
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      !(event.target instanceof HTMLElement) ||
      !event.target.matches("[data-entry-path]")
    )
      return;
    const command = commandFor(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        repeat: event.repeat,
        isComposing: event.nativeEvent.isComposing,
      },
      {
        index: focusIndex,
        count: layout.entries.length,
        columns: layout.columns,
        pageSize: virtual.rowsPerPage() * layout.columns,
        isMac: isMac(),
      },
    );
    if (!command) return;
    const focused = focusIndex >= 0 ? layout.entries[focusIndex] : undefined;
    switch (command.type) {
      case "move":
        focusEntry(command.index, command.mode);
        break;
      case "open":
        if (!focused) return;
        activate(focused);
        break;
      case "preview":
        if (!focused) return;
        if (focused.type === "dir") focusEntry(focusIndex, "toggle");
        // Open on key release: opening now moves focus into the dialog, where the release of the
        // same Space press would activate its focused button and close it again.
        else previewOnRelease.current = focused;
        break;
      case "toggle":
        if (focusIndex < 0) return;
        focusEntry(focusIndex, "toggle");
        break;
      case "selectAll":
        setSelection(Selection.all(order));
        break;
      case "clear":
        if (selection.paths.size === 0) return;
        setSelection(Selection.empty);
        break;
      case "trash": {
        const targets = commandTargets().filter(
          (entry) => entry.permission !== "read",
        );
        if (targets.length === 0) return;
        open({ action: "delete", entries: targets });
        break;
      }
      case "rename": {
        const [entry, ...rest] = commandTargets();
        if (!entry || rest.length > 0 || !FileEntry.canMove(entry)) return;
        open({ action: "rename", entry });
        break;
      }
      case "help":
        setHelpOpen(true);
        break;
      case "typeahead": {
        const state = typeahead.current;
        if (state.timer) clearTimeout(state.timer);
        state.text += command.text;
        state.timer = setTimeout(() => {
          state.text = "";
          state.timer = null;
        }, 700);
        const match = typeaheadMatch(names, focusIndex, state.text);
        if (match >= 0) focusEntry(match, "select");
        break;
      }
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const onEntryClick = (
    event: MouseEvent<HTMLElement>,
    entry: FileEntry,
    index: number,
  ) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      event.preventDefault();
      return;
    }
    const mod = isMac() ? event.metaKey : event.ctrlKey;
    const checkbox =
      event.target instanceof Element &&
      event.target.closest("[data-entry-check]") !== null;
    setFocusPath(entry.path);
    if (event.shiftKey) {
      event.preventDefault();
      setSelection((current) =>
        Selection.range(current, order, entry.path, mod),
      );
      return;
    }
    if (mod || checkbox || touchSelecting) {
      event.preventDefault();
      focusEntry(index, "toggle");
      return;
    }
    // A plain click opens the entry, like a link, and ends any selection.
    setSelection(Selection.empty);
    if (entry.type !== "dir") open({ action: "preview", entry });
  };

  const cancelLongPress = () => {
    if (longPress.current) clearTimeout(longPress.current.timer);
    longPress.current = null;
  };
  const onEntryPointerDown = (
    event: PointerEvent<HTMLElement>,
    index: number,
  ) => {
    if (event.pointerType !== "touch") return;
    cancelLongPress();
    longPress.current = {
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(() => {
        longPress.current = null;
        suppressClick.current = true;
        setTouchSelecting(true);
        focusEntry(index, "toggle");
      }, longPressMs),
    };
  };
  const onEntryPointerMove = (event: PointerEvent<HTMLElement>) => {
    const start = longPress.current;
    if (
      start &&
      Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10
    )
      cancelLongPress();
  };

  const onContainerPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // Pressing empty space between entries clears the selection, as in desktop file managers.
    if (event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey)
      return;
    if (
      event.target instanceof Element &&
      event.target.closest("[data-entry-row]")
    )
      return;
    setSelection(Selection.empty);
  };

  const headerRows = layout.rows.flatMap((row, index) =>
    row.kind === "header" ? [index] : [],
  );
  const headersBefore = (rowIndex: number) =>
    headerRows.filter((header) => header < rowIndex).length;
  const entriesBefore = (rowIndex: number) => {
    for (let index = rowIndex; index < layout.rows.length; index++) {
      const row = layout.rows[index];
      if (row?.kind === "entries") return row.start;
    }
    return layout.entries.length;
  };
  const focusedRow =
    focusIndex >= 0 ? EntryLayout.rowOf(layout, focusIndex) : -1;
  const rendered: number[] = [];
  for (let index = virtual.range.start; index < virtual.range.end; index++)
    rendered.push(index);
  if (
    focusedRow >= 0 &&
    (focusedRow < virtual.range.start || focusedRow >= virtual.range.end)
  )
    rendered.push(focusedRow);
  const selectionActive = selection.paths.size > 0;
  // The list's one Tab stop. With nothing focused yet it is the first entry in the rendered
  // window, so Tab reaches the list after scrolling and lands on what is on screen.
  const tabStop =
    focusPath ??
    layout.entries[entriesBefore(virtual.range.start)]?.path ??
    order.paths[0] ??
    null;

  /**
   * Opening a menu on an entry focuses it, and selects only it unless it is already selected.
   * The menu then acts on the whole selection when the entry is part of one.
   */
  const menuTarget = (path: string): EntryMenuTarget | null => {
    const index = order.index.get(path);
    const entry = index === undefined ? undefined : layout.entries[index];
    if (!entry) return null;
    setFocusPath(path);
    if (selection.paths.has(path)) return { entry, targets: targetsFor(entry) };
    setSelection(Selection.only(path));
    return { entry, targets: [entry] };
  };

  // One stable handler object for every row; its methods call this render's handlers.
  const latest = useRef<EntryRowHandlers | null>(null);
  useLayoutEffect(() => {
    latest.current = {
      click: onEntryClick,
      pointerDown: onEntryPointerDown,
      pointerMove: onEntryPointerMove,
      pointerEnd: cancelLongPress,
      nativeContextMenu: (event) => {
        // Touch long-press selects instead of opening the browser's link menu.
        if (suppressClick.current || touchSelecting) event.preventDefault();
      },
      openDrawer: (entry) => {
        const target = menuTarget(entry.path);
        setMenu(target && EntryMenu.inDrawer(target));
      },
      focus: (entry) => {
        if (focusPath !== entry.path) setFocusPath(entry.path);
      },
      dragProps: (entry) => drag.getDragProps(entry, () => targetsFor(entry)),
    };
  });
  const [handlers] = useState<EntryRowHandlers>(() => {
    const call = () => {
      if (!latest.current)
        throw new Error("Entry handlers ran before the file view rendered.");
      return latest.current;
    };
    return {
      click: (...args) => call().click(...args),
      pointerDown: (...args) => call().pointerDown(...args),
      pointerMove: (...args) => call().pointerMove(...args),
      pointerEnd: () => call().pointerEnd(),
      nativeContextMenu: (...args) => call().nativeContextMenu(...args),
      openDrawer: (...args) => call().openDrawer(...args),
      focus: (...args) => call().focus(...args),
      dragProps: (...args) => call().dragProps(...args),
    };
  });
  const multiSelection = selectedEntries.length > 1 ? selectedEntries : null;
  const dragLocked = drag.state.status === "moving";

  const renderEntry = (
    entry: FileEntry,
    index: number,
    rowIndex: number,
    position: { top: number; height: number; left?: string; width?: string },
  ) => {
    const selected = selection.paths.has(entry.path);
    return (
      <EntryRow
        key={entry.path}
        entry={entry}
        index={index}
        ariaRowIndex={index + headersBefore(rowIndex) + 1}
        view={view}
        selected={selected}
        selectionActive={selectionActive}
        tabbable={entry.path === tabStop}
        dragging={drag.isDragging(entry)}
        dropTarget={drag.isDropTarget(entry)}
        dragLocked={dragLocked}
        touch={isMobile}
        selectionTargets={selected ? multiSelection : null}
        menuOpen={menu?.entry.path === entry.path}
        actions={actions}
        handlers={handlers}
        renderName={renderName}
        {...position}
      />
    );
  };

  const bar = selectionActive ? (
    <SelectionBar
      targets={selectedEntries}
      total={layout.entries.length}
      floating={!selectionSlot}
      actions={actions}
      onOpen={open}
      onSelectAll={() => setSelection(Selection.all(order))}
      onClear={() => setSelection(Selection.empty)}
    />
  ) : null;

  return (
    <>
      {drag.state.status === "error" && (
        <p role="alert" className="mb-3 text-pretty text-sm text-destructive">
          {drag.state.message}
        </p>
      )}
      {drag.state.status === "moving" && (
        <p role="status" className="sr-only">
          Moving{" "}
          {drag.state.sources.length === 1
            ? drag.state.sources[0]?.name
            : `${drag.state.sources.length} items`}
          …
        </p>
      )}
      <p id="entries-keyboard-hint" className="sr-only">
        Use arrow keys to move, Enter to open, and question mark for keyboard
        shortcuts.
      </p>
      <EntryMenuHost
        touch={isMobile}
        menu={menu}
        onMenuChange={setMenu}
        resolve={menuTarget}
        actions={actions}
        open={open}
        onClosed={() => {
          // Actions that open a dialog move focus there. Otherwise return it to the entry.
          if (
            document.activeElement &&
            document.activeElement !== document.body
          )
            return;
          if (focusPath)
            containerRef.current
              ?.querySelector<HTMLElement>(
                `[data-entry-path="${CSS.escape(focusPath)}"]`,
              )
              ?.focus();
        }}
      >
        <div
          ref={containerRef}
          inert={stale}
          aria-busy={stale}
          role="grid"
          aria-label={label}
          aria-multiselectable="true"
          aria-rowcount={layout.entries.length + headerRows.length}
          aria-colcount={1}
          aria-describedby="entries-keyboard-hint"
          // Fades only when loading takes long enough to notice.
          className={cn(
            "relative transition-opacity",
            stale && "opacity-60 delay-300",
          )}
          style={{ height: layout.height }}
          onKeyDown={onKeyDown}
          onKeyUp={(event) => {
            const entry = previewOnRelease.current;
            if (event.key !== " " || !entry) return;
            previewOnRelease.current = null;
            event.preventDefault();
            open({ action: "preview", entry });
          }}
          onPointerDown={onContainerPointerDown}
        >
          {rendered.map((rowIndex) => {
            const row = layout.rows[rowIndex];
            if (!row) return null;
            const position = {
              position: "absolute",
              top: row.top,
              left: 0,
              right: 0,
              height: row.height,
            } as const;
            if (row.kind === "header")
              return (
                <div
                  key={`header:${row.title}`}
                  role="row"
                  aria-rowindex={
                    entriesBefore(rowIndex) + headersBefore(rowIndex) + 1
                  }
                  style={position}
                >
                  <h2
                    role="columnheader"
                    className="px-3 text-balance text-xs font-medium text-muted-foreground"
                  >
                    {row.title}
                  </h2>
                </div>
              );
            if (view === "list") {
              const entry = layout.entries[row.start];
              return entry
                ? renderEntry(entry, row.start, rowIndex, {
                    top: row.top,
                    height: row.height,
                  })
                : null;
            }
            // Cards are positioned one by one, without row wrappers, so a change in column count only
            // restyles them. Remounting under a new wrapper would drop focus and in-flight clicks.
            const { gap } = entryGeometry.grid;
            const columns = layout.columns;
            const width = `((100% - ${(columns - 1) * gap}px) / ${columns})`;
            return layout.entries
              .slice(row.start, row.start + row.count)
              .map((entry, offset) =>
                renderEntry(entry, row.start + offset, rowIndex, {
                  top: row.top,
                  height: row.height,
                  width: `calc${width}`,
                  left: `calc(${width} * ${offset} + ${offset * gap}px)`,
                }),
              );
          })}
        </div>
      </EntryMenuHost>
      {bar && (selectionSlot ? createPortal(bar, selectionSlot) : bar)}
      <ShortcutHelp
        open={helpOpen}
        onOpenChange={setHelpOpen}
        onClosed={() => {
          if (!focusPath) return;
          containerRef.current
            ?.querySelector<HTMLElement>(
              `[data-entry-path="${CSS.escape(focusPath)}"]`,
            )
            ?.focus();
        }}
      />
      {dialog?.action === "preview" ? (
        <PreviewDialog
          entry={dialog.entry}
          entries={previewable}
          onNavigate={(entry) => onDialog({ action: "preview", entry })}
          onClose={() => onDialog(null)}
        />
      ) : dialog?.action === "share" ? (
        <SharingDialog entry={dialog.entry} onClose={() => onDialog(null)} />
      ) : dialog?.action === "versions" ? (
        <VersionsDialog entry={dialog.entry} onClose={() => onDialog(null)} />
      ) : (
        dialog && (
          <EditEntryDialog
            key={
              dialog.action === "rename"
                ? `rename:${dialog.entry.path}`
                : dialog.action
            }
            dialog={dialog}
            actions={actions}
            onClose={() => onDialog(null)}
          />
        )
      )}
    </>
  );
}
