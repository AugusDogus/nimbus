import { ChevronRight, Folder } from "lucide-react";
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { cn } from "@/lib/utils";
import { typeaheadMatch } from "../entry-keys";
import { EntryLayout } from "../entry-layout";
import { useVirtualRows } from "../use-virtual-rows";
import {
  DestinationEligibility,
  type Eligibility,
} from "./destination-eligibility";

/** One folder offered in the picker. */
export type FolderRow = {
  path: string;
  name: string;
  /** Where the folder is, for rows outside the browsed folder such as search results. */
  detail?: string;
  eligibility: Eligibility;
};

const navigable = (row: FolderRow) =>
  row.eligibility.kind === "eligible" || row.eligibility.navigable;

/**
 * Folders as a list with one Tab stop: arrows, Home, End, Page Up and Down move between them,
 * typing a name's first letters jumps to it, and Enter or Right opens one. Above 300 folders
 * only the rows near the visible area are rendered, with the main listing's fixed geometry.
 */
export function FolderList({
  rows,
  label,
  restoreKey,
  onOpen,
}: {
  rows: readonly FolderRow[];
  label: string;
  /** Identifies the list, so returning to a folder restores its scroll position. */
  restoreKey: string;
  onOpen: (row: FolderRow) => void;
}) {
  const layout = useMemo(
    () => EntryLayout.build([{ title: "", entries: rows }], "list", 1),
    [rows],
  );
  const names = useMemo(() => rows.map((row) => row.name), [rows]);
  const containerRef = useRef<HTMLDivElement>(null);
  const obstructionRef = useRef<HTMLElement>(null);
  const virtual = useVirtualRows({
    layout,
    containerRef,
    obstructionRef,
    restoreKey,
  });
  const [focused, setFocused] = useState<{ key: string; index: number }>({
    key: restoreKey,
    index: 0,
  });
  // A new list starts at its first row.
  const focusIndex =
    focused.key === restoreKey ? Math.min(focused.index, rows.length - 1) : 0;
  const pendingFocus = useRef<number | null>(null);
  const typeahead = useRef<{
    text: string;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ text: "", timer: null });

  const focusRow = (index: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, index));
    setFocused({ key: restoreKey, index: next });
    pendingFocus.current = next;
    virtual.revealRow(EntryLayout.rowOf(layout, next));
  };

  // A row moved to by keyboard may not have been rendered yet: focus it once it is.
  useLayoutEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    const element = containerRef.current?.querySelector<HTMLElement>(
      `[data-folder-index="${index}"]`,
    );
    if (!element) return;
    pendingFocus.current = null;
    element.focus({ preventScroll: true });
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const page = Math.max(1, virtual.rowsPerPage());
    const row = rows[focusIndex];
    switch (event.key) {
      case "ArrowDown":
        focusRow(focusIndex + 1);
        break;
      case "ArrowUp":
        focusRow(focusIndex - 1);
        break;
      case "Home":
        focusRow(0);
        break;
      case "End":
        focusRow(rows.length - 1);
        break;
      case "PageDown":
        focusRow(focusIndex + page);
        break;
      case "PageUp":
        focusRow(focusIndex - page);
        break;
      case "Enter":
      case "ArrowRight":
        if (!row || !navigable(row)) return;
        onOpen(row);
        break;
      default: {
        if (event.key.length !== 1 || event.key === " ") return;
        const state = typeahead.current;
        if (state.timer) clearTimeout(state.timer);
        state.text += event.key;
        state.timer = setTimeout(() => {
          state.text = "";
          state.timer = null;
        }, 700);
        const match = typeaheadMatch(names, focusIndex, state.text);
        if (match < 0) return;
        focusRow(match);
      }
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const rendered: number[] = [];
  for (let index = virtual.range.start; index < virtual.range.end; index++)
    rendered.push(index);
  const focusedRow = EntryLayout.rowOf(layout, focusIndex);
  if (
    focusedRow >= 0 &&
    (focusedRow < virtual.range.start || focusedRow >= virtual.range.end)
  )
    rendered.push(focusedRow);

  return (
    <div
      ref={containerRef}
      role="listbox"
      aria-label={label}
      className="relative"
      style={{ height: layout.height }}
      onKeyDown={onKeyDown}
    >
      {rendered.map((rowIndex) => {
        const position = layout.rows[rowIndex];
        if (!position || position.kind !== "entries") return null;
        const row = rows[position.start];
        if (!row) return null;
        const index = position.start;
        const open = navigable(row);
        const blocked =
          row.eligibility.kind === "blocked" ? row.eligibility.reason : null;
        return (
          <div
            key={row.path}
            role="option"
            aria-selected={index === focusIndex}
            aria-disabled={!open || undefined}
            tabIndex={index === focusIndex ? 0 : -1}
            data-folder-index={index}
            data-folder-path={row.path}
            title={row.detail ? `${row.detail}/${row.name}` : row.name}
            onFocus={() => {
              if (index !== focusIndex) setFocused({ key: restoreKey, index });
            }}
            onClick={() => {
              setFocused({ key: restoreKey, index });
              if (open) onOpen(row);
            }}
            className={cn(
              "absolute inset-x-0 flex items-center gap-3 rounded-md px-3 text-sm outline-none select-none",
              "focus-visible:ring-2 focus-visible:ring-ring",
              open
                ? "cursor-pointer hover:bg-accent hover:text-accent-foreground"
                : "cursor-not-allowed text-muted-foreground",
            )}
            style={{ top: position.top, height: position.height }}
          >
            <Folder
              aria-hidden="true"
              className={cn(
                "size-5 shrink-0",
                open ? "text-primary" : "text-muted-foreground",
              )}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{row.name}</span>
              {row.detail !== undefined && (
                <span className="truncate text-xs text-muted-foreground">
                  {row.detail}
                </span>
              )}
            </span>
            {blocked && (
              <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {DestinationEligibility.labels[blocked]}
              </span>
            )}
            {open && (
              <ChevronRight
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
