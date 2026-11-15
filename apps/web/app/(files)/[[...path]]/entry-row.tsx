"use client";

import { Check, FileText, Folder } from "lucide-react";
import Link from "next/link";
import { memo, type DragEvent, type MouseEvent, type PointerEvent } from "react";
// Rows mount continuously while scrolling large folders. Their classes never conflict, so they
// are joined directly instead of through tailwind-merge.
const classes = (...values: (string | false)[]) => values.filter(Boolean).join(" ");
import { EntryActionsButton, openMenuAt } from "./entry-menu";
import { EntryThumbnail } from "./entry-thumbnail";
import { fileHref, FileEntry } from "./types";
import type { useFileActions } from "./use-file-actions";

type DragProps = {
  draggable: boolean;
  onDragStart?: (event: DragEvent<HTMLElement>) => void;
  onDragEnd?: () => void;
  onDragOver?: (event: DragEvent<HTMLElement>) => void;
  onDragLeave?: (event: DragEvent<HTMLElement>) => void;
  onDrop?: (event: DragEvent<HTMLElement>) => void;
};

/**
 * Callbacks shared by every row. The view passes one stable object whose methods call its latest
 * handlers, so rows re-render only when their own data changes, not on every scroll frame.
 */
export type EntryRowHandlers = {
  click(event: MouseEvent<HTMLElement>, entry: FileEntry, index: number): void;
  pointerDown(event: PointerEvent<HTMLElement>, index: number): void;
  pointerMove(event: PointerEvent<HTMLElement>): void;
  pointerEnd(): void;
  nativeContextMenu(event: MouseEvent<HTMLElement>): void;
  /** Open the touch actions drawer for an entry. */
  openDrawer(entry: FileEntry): void;
  focus(entry: FileEntry): void;
  dragProps(entry: FileEntry): DragProps;
};

type Props = {
  entry: FileEntry;
  index: number;
  ariaRowIndex: number;
  view: "list" | "grid";
  selected: boolean;
  selectionActive: boolean;
  tabbable: boolean;
  dragging: boolean;
  dropTarget: boolean;
  /** A move is running: nothing can be dragged until it ends. */
  dragLocked: boolean;
  /** Touch layouts move items with the Move action instead of dragging. */
  touch: boolean;
  /** The whole selection when this entry is part of a multi-selection, otherwise null. */
  selectionTargets: readonly FileEntry[] | null;
  /** This row's actions menu is open. */
  menuOpen: boolean;
  actions: ReturnType<typeof useFileActions>;
  handlers: EntryRowHandlers;
  top: number;
  height: number;
  /** Grid cards set their horizontal position; list rows span the width. */
  left?: string;
  width?: string;
};

export const EntryRow = memo(function EntryRow({
  entry,
  index,
  ariaRowIndex,
  view,
  selected,
  selectionActive,
  tabbable,
  dragging,
  dropTarget,
  dragLocked,
  touch,
  selectionTargets,
  menuOpen,
  actions,
  handlers,
  top,
  height,
  left,
  width,
}: Props) {
  const Icon = entry.type === "dir" ? Folder : FileText;
  // Handlers resolve at event time: the view's handlers do not exist during server rendering.
  const drag = touch
    ? { draggable: false }
    : {
        draggable: !dragLocked && FileEntry.canMove(entry),
        onDragStart: (event: DragEvent<HTMLElement>) => handlers.dragProps(entry).onDragStart?.(event),
        onDragEnd: () => handlers.dragProps(entry).onDragEnd?.(),
        onDragOver: (event: DragEvent<HTMLElement>) => handlers.dragProps(entry).onDragOver?.(event),
        onDragLeave: (event: DragEvent<HTMLElement>) => handlers.dragProps(entry).onDragLeave?.(event),
        onDrop: (event: DragEvent<HTMLElement>) => handlers.dragProps(entry).onDrop?.(event),
      };
  const check = (
    <span
      data-entry-check
      aria-hidden
      className={classes(
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
            className={classes(
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
          {/* The thumbnail box has a fixed size, so the windowed grid keeps fixed row heights. */}
          <EntryThumbnail
            entry={entry}
            fallback={<Icon className={classes("size-12 shrink-0 text-muted-foreground", entry.type === "dir" && "fill-muted")} />}
            className="h-20 w-full"
          />
        </>
      )}
      <span className={classes("min-w-0 truncate text-sm", view === "grid" && "w-full text-center")}>{entry.name}</span>
    </>
  );
  const common = {
    ...drag,
    "aria-busy": dragLocked && dragging,
    "data-drop-target": dropTarget || undefined,
    className: classes(
      "w-full rounded-lg text-left [-webkit-touch-callout:none] focus-visible:outline-2 focus-visible:outline-ring",
      view === "list"
        ? "flex h-12 items-center gap-3 py-3 pl-3 pr-12"
        : "relative flex h-42 flex-col items-center justify-center gap-3 border px-4 pb-4 pt-10",
      // Background states are exclusive, so no class merging is needed.
      selected || dropTarget ? "bg-accent" : view === "grid" ? "bg-muted/30 hover:bg-accent/70" : "hover:bg-accent/70",
      dragging && "opacity-50",
      dropTarget && "ring-2 ring-inset ring-primary",
    ),
    tabIndex: tabbable ? 0 : -1,
    "data-entry-name": entry.name,
    "data-entry-path": entry.path,
    onClick: (event: MouseEvent<HTMLElement>) => handlers.click(event, entry, index),
    onPointerDown: (event: PointerEvent<HTMLElement>) => handlers.pointerDown(event, index),
    onPointerMove: handlers.pointerMove,
    onPointerUp: handlers.pointerEnd,
    onPointerCancel: handlers.pointerEnd,
    onContextMenu: handlers.nativeContextMenu,
  };
  return (
    <div
      role="row"
      aria-rowindex={ariaRowIndex}
      aria-selected={selected}
      data-entry-row
      data-row-path={entry.path}
      className="group/entry"
      style={{ position: "absolute", top, height, left: left ?? 0, ...(width ? { width } : { right: 0 }) }}
    >
      <div role="gridcell" className="relative h-full">
        {entry.type === "dir" ? (
          <Link
            {...common}
            href={fileHref(entry.path)}
            // Rows scroll past by the hundred. Prefetching each into the router cache would fetch
            // pages nobody opens; listings are prefetched on hover and focus instead.
            prefetch={false}
            onMouseEnter={() => actions.prefetchFolder(entry)}
            onFocus={() => {
              handlers.focus(entry);
              actions.prefetchFolder(entry);
            }}
          >
            {content}
          </Link>
        ) : (
          <button {...common} type="button" onFocus={() => handlers.focus(entry)}>
            {content}
          </button>
        )}
        <EntryActionsButton
          name={entry.name}
          count={selectionTargets?.length ?? 1}
          tabbable={tabbable}
          open={menuOpen}
          onOpen={(event) => {
            if (touch) handlers.openDrawer(entry);
            else openMenuAt(event.currentTarget);
          }}
        />
      </div>
    </div>
  );
});
