"use client";

import { Check, FileText, Folder } from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { EntryMenu } from "./entry-menu";
import { EditEntryDialog, type EntryDialog } from "./entry-dialogs";
import { commandFor, typeaheadMatch } from "./entry-keys";
import { EntryLayout, entryGeometry, type EntrySection } from "./entry-layout";
import { PreviewDialog } from "./preview-dialog";
import { Selection } from "./selection";
import { SelectionBar } from "./selection-bar";
import { SharingDialog } from "./sharing-dialog";
import { ShortcutHelp } from "./shortcut-help";
import { fileHref, FileEntry } from "./types";
import type { useFileActions } from "./use-file-actions";
import { useFileDrag } from "./use-file-drag";
import { useGridColumns } from "./use-grid-columns";
import { useVirtualRows } from "./use-virtual-rows";

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
};

const longPressMs = 450;
const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
const imagePattern = /\.(png|jpe?g|webp|gif|avif)$/i;

export function EntriesView({ view, sections, actions, restoreKey, label, toolbarRef, selectionSlot }: Props) {
  const router = useRouter();
  const isMobile = useIsMobile();
  const columns = useGridColumns();
  const layout = useMemo(() => EntryLayout.build(sections, view, view === "grid" ? columns : 1), [sections, view, columns]);
  const order = useMemo(() => Selection.order(layout.entries.map((entry) => entry.path)), [layout.entries]);
  const names = useMemo(() => layout.entries.map((entry) => entry.name), [layout.entries]);

  const [selection, setSelection] = useState(Selection.empty);
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [touchSelecting, setTouchSelecting] = useState(false);
  const [dialog, setDialog] = useState<EntryDialog | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  // Entries can leave the folder through live updates, moves, and other clients.
  const retained = Selection.retain(selection, order);
  if (retained !== selection) setSelection(retained);
  if (focusPath !== null && !order.index.has(focusPath)) setFocusPath(null);
  if (touchSelecting && selection.paths.size === 0) setTouchSelecting(false);
  const focusIndex = focusPath === null ? -1 : (order.index.get(focusPath) ?? -1);
  const tabStop = focusPath ?? order.paths[0] ?? null;

  const containerRef = useRef<HTMLDivElement>(null);
  const fallbackToolbar = useRef<HTMLElement>(null);
  const virtual = useVirtualRows({ layout, containerRef, obstructionRef: toolbarRef ?? fallbackToolbar, restoreKey });
  const drag = useFileDrag(actions);
  const pendingFocus = useRef<string | null>(null);
  const typeahead = useRef<{ text: string; timer: ReturnType<typeof setTimeout> | null }>({ text: "", timer: null });
  const longPress = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);

  const selectedEntries = useMemo(
    () => (selection.paths.size === 0 ? [] : layout.entries.filter((entry) => selection.paths.has(entry.path))),
    [layout.entries, selection.paths],
  );
  /** What an action on `entry` applies to: the selection when it includes `entry`. */
  const targetsFor = useCallback(
    (entry: FileEntry) => (selection.paths.has(entry.path) && selection.paths.size > 1 ? selectedEntries : [entry]),
    [selectedEntries, selection.paths],
  );

  const open = (next: EntryDialog) => {
    setDialog(next);
    if (next.action === "preview") void actions.recordVisit(next.entry.path);
  };

  const focusEntry = (index: number, mode: "select" | "extend" | "focus" | "toggle") => {
    const path = order.paths[index];
    if (path === undefined) return;
    setFocusPath(path);
    if (mode === "select") setSelection(Selection.only(path));
    if (mode === "extend") setSelection((current) => Selection.range(current.anchor === null && focusPath ? Selection.only(focusPath) : current, order, path, false));
    if (mode === "toggle") setSelection((current) => Selection.toggle(current, path));
    pendingFocus.current = path;
    virtual.revealRow(EntryLayout.rowOf(layout, index));
  };

  // Keyboard moves can target rows that were not mounted yet. Focus them once they render.
  useLayoutEffect(() => {
    const path = pendingFocus.current;
    if (!path) return;
    const element = containerRef.current?.querySelector<HTMLElement>(`[data-entry-path="${CSS.escape(path)}"]`);
    if (!element) return;
    pendingFocus.current = null;
    element.focus({ preventScroll: true });
  });

  const activate = (entry: FileEntry) => {
    if (entry.type === "dir") router.push(fileHref(entry.path));
    else open({ action: "preview", entry });
  };

  const commandTargets = () => {
    if (selectedEntries.length > 0) return selectedEntries;
    const focused = focusIndex >= 0 ? layout.entries[focusIndex] : undefined;
    return focused ? [focused] : [];
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement) || !event.target.matches("[data-entry-path]")) return;
    const command = commandFor({
      key: event.key,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      repeat: event.repeat,
      isComposing: event.nativeEvent.isComposing,
    }, {
      index: focusIndex,
      count: layout.entries.length,
      columns: layout.columns,
      pageSize: virtual.rowsPerPage() * layout.columns,
      isMac: isMac(),
    });
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
        else open({ action: "preview", entry: focused });
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
        const targets = commandTargets().filter((entry) => entry.permission !== "read");
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

  const onEntryClick = (event: MouseEvent<HTMLElement>, entry: FileEntry, index: number) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      event.preventDefault();
      return;
    }
    const mod = isMac() ? event.metaKey : event.ctrlKey;
    const checkbox = event.target instanceof Element && event.target.closest("[data-entry-check]") !== null;
    setFocusPath(entry.path);
    if (event.shiftKey) {
      event.preventDefault();
      setSelection((current) => Selection.range(current, order, entry.path, mod));
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
  const onEntryPointerDown = (event: PointerEvent<HTMLElement>, index: number) => {
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
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancelLongPress();
  };

  const onContainerPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // Pressing empty space between entries clears the selection, as in desktop file managers.
    if (event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey) return;
    if (event.target instanceof Element && event.target.closest("[data-entry-row]")) return;
    setSelection(Selection.empty);
  };

  const headerRows = layout.rows.flatMap((row, index) => (row.kind === "header" ? [index] : []));
  const headersBefore = (rowIndex: number) => headerRows.filter((header) => header < rowIndex).length;
  const entriesBefore = (rowIndex: number) => {
    for (let index = rowIndex; index < layout.rows.length; index++) {
      const row = layout.rows[index];
      if (row?.kind === "entries") return row.start;
    }
    return layout.entries.length;
  };
  const focusedRow = focusIndex >= 0 ? EntryLayout.rowOf(layout, focusIndex) : -1;
  const rendered: number[] = [];
  for (let index = virtual.range.start; index < virtual.range.end; index++) rendered.push(index);
  if (focusedRow >= 0 && (focusedRow < virtual.range.start || focusedRow >= virtual.range.end)) rendered.push(focusedRow);
  const selectionActive = selection.paths.size > 0;

  const renderEntry = (entry: FileEntry, index: number, rowIndex: number, style?: CSSProperties) => {
    const selected = selection.paths.has(entry.path);
    const isImage = view === "grid" && entry.type === "file" && imagePattern.test(entry.name);
    const Icon = entry.type === "dir" ? Folder : FileText;
    const dragProps = isMobile ? {} : drag.getDragProps(entry, () => targetsFor(entry));
    const check = (
      <span
        data-entry-check
        aria-hidden
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full border transition-opacity duration-150",
          selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/60 bg-background",
          selected || selectionActive ? "opacity-100" : "opacity-0 md:group-hover/entry:opacity-100",
        )}
      >
        {selected && <Check className="size-3.5" strokeWidth={3} />}
      </span>
    );
    const content = (
      <>
        {view === "list" ? (
          <span className="relative flex size-5 shrink-0 items-center justify-center">
            <Icon
              className={cn(
                "size-5 text-muted-foreground transition-opacity duration-150",
                entry.type === "dir" && "fill-muted",
                selected || selectionActive ? "opacity-0" : "md:group-hover/entry:opacity-0",
              )}
            />
            <span className="absolute inset-0">{check}</span>
          </span>
        ) : (
          <>
            <span className="absolute left-2 top-2">{check}</span>
            {isImage ? (
              <Image
                draggable={false}
                unoptimized
                src={`/api/files/thumbnail?path=${encodeURIComponent(entry.path)}`}
                width={128}
                height={80}
                alt=""
                className="h-20 w-full object-contain"
              />
            ) : (
              <Icon className={cn("size-12 shrink-0 text-muted-foreground", entry.type === "dir" && "fill-muted")} />
            )}
          </>
        )}
        <span className={cn("min-w-0 truncate text-sm", view === "grid" && "w-full text-center")}>{entry.name}</span>
      </>
    );
    const className = cn(
      "w-full rounded-lg text-left [-webkit-touch-callout:none] hover:bg-accent/70 focus-visible:outline-2 focus-visible:outline-ring",
      view === "list"
        ? "flex h-12 items-center gap-3 py-3 pl-3 pr-12"
        : "relative flex h-42 flex-col items-center justify-center gap-3 border bg-muted/30 px-4 pb-4 pt-10",
      selected && "bg-accent hover:bg-accent",
      drag.isDragging(entry) && "opacity-50",
      drag.isDropTarget(entry) && "bg-accent ring-2 ring-inset ring-primary",
    );
    const common = {
      ...dragProps,
      className,
      tabIndex: entry.path === tabStop ? 0 : -1,
      "data-entry-name": entry.name,
      "data-entry-path": entry.path,
      onFocus: () => {
        if (focusPath !== entry.path) setFocusPath(entry.path);
      },
      onClick: (event: MouseEvent<HTMLElement>) => onEntryClick(event, entry, index),
      onPointerDown: (event: PointerEvent<HTMLElement>) => onEntryPointerDown(event, index),
      onPointerMove: onEntryPointerMove,
      onPointerUp: cancelLongPress,
      onPointerCancel: cancelLongPress,
      onContextMenu: (event: MouseEvent<HTMLElement>) => {
        // Touch long-press selects instead of opening the browser's link menu.
        if (suppressClick.current || touchSelecting) event.preventDefault();
      },
    };
    return (
      <EntryMenu
        key={entry.path}
        entry={entry}
        targets={targetsFor(entry)}
        actions={actions}
        onSelect={open}
        tabbable={entry.path === tabStop}
        onContextMenu={() => {
          setFocusPath(entry.path);
          if (!selection.paths.has(entry.path)) setSelection(Selection.only(entry.path));
        }}
        rowProps={{
          role: "row",
          "aria-rowindex": index + headersBefore(rowIndex) + 1,
          "aria-selected": selected,
          "data-entry-row": true,
          style,
        }}
      >
        {entry.type === "dir" ? (
          <Link {...common} href={fileHref(entry.path)} onMouseEnter={() => actions.prefetchFolder(entry)} onFocus={() => {
            common.onFocus();
            actions.prefetchFolder(entry);
          }}>
            {content}
          </Link>
        ) : (
          <button {...common} type="button">
            {content}
          </button>
        )}
      </EntryMenu>
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
        <p role="alert" className="mb-3 text-pretty text-sm text-destructive">{drag.state.message}</p>
      )}
      {drag.state.status === "moving" && (
        <p role="status" className="sr-only">
          Moving {drag.state.sources.length === 1 ? drag.state.sources[0]?.name : `${drag.state.sources.length} items`}…
        </p>
      )}
      <p id="entries-keyboard-hint" className="sr-only">
        Use arrow keys to move, Enter to open, and question mark for keyboard shortcuts.
      </p>
      <div
        ref={containerRef}
        role="grid"
        aria-label={label}
        aria-multiselectable="true"
        aria-rowcount={layout.entries.length + headerRows.length}
        aria-colcount={1}
        aria-describedby="entries-keyboard-hint"
        className="relative"
        style={{ height: layout.height }}
        onKeyDown={onKeyDown}
        onPointerDown={onContainerPointerDown}
      >
        {rendered.map((rowIndex) => {
          const row = layout.rows[rowIndex];
          if (!row) return null;
          const position = { position: "absolute", top: row.top, left: 0, right: 0, height: row.height } as const;
          if (row.kind === "header")
            return (
              <div key={`header:${row.title}`} role="row" aria-rowindex={entriesBefore(rowIndex) + headersBefore(rowIndex) + 1} style={position}>
                <h2 role="columnheader" className="px-3 text-balance text-xs font-medium text-muted-foreground">
                  {row.title}
                </h2>
              </div>
            );
          if (view === "list") {
            const entry = layout.entries[row.start];
            return entry ? renderEntry(entry, row.start, rowIndex, position) : null;
          }
          return (
            <div
              key={`row:${row.start}`}
              role="presentation"
              className="grid"
              style={{ ...position, gap: entryGeometry.grid.gap, gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))` }}
            >
              {layout.entries.slice(row.start, row.start + row.count).map((entry, offset) => renderEntry(entry, row.start + offset, rowIndex))}
            </div>
          );
        })}
      </div>
      {bar && (selectionSlot ? createPortal(bar, selectionSlot) : bar)}
      <ShortcutHelp open={helpOpen} onOpenChange={setHelpOpen} />
      {dialog?.action === "preview" ? (
        <PreviewDialog entry={dialog.entry} onClose={() => setDialog(null)} />
      ) : dialog?.action === "share" ? (
        <SharingDialog entry={dialog.entry} onClose={() => setDialog(null)} />
      ) : (
        dialog && (
          <EditEntryDialog
            key={dialog.action === "rename" ? `rename:${dialog.entry.path}` : dialog.action}
            dialog={dialog}
            actions={actions}
            onClose={() => setDialog(null)}
          />
        )
      )}
    </>
  );
}
