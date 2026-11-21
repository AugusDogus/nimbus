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
import { DropTarget, type DropVerdict } from "../drop-target";

/** One folder offered in the picker. */
export type FolderRow = {
  path: string;
  name: string;
  /** Where the folder is, for rows outside the browsed folder such as search results. */
  detail?: string;
  /** Whether the folder takes the items, and if not, why; see `DropTarget.forItems`. */
  eligibility: DropVerdict;
};

const navigable = (row: FolderRow) =>
  row.eligibility.kind !== "refused" ||
  DropTarget.leadsOn(row.eligibility.reason);

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
  focusRequest,
  stale = false,
}: {
  rows: readonly FolderRow[];
  label: string;
  /** Identifies the list, so returning to a folder restores its scroll position. */
  restoreKey: string;
  onOpen: (row: FolderRow) => void;
  /**
   * Move focus into the list once its rows are shown: to the row of `path` when it has one,
   * such as the folder just left by going up, otherwise to the first row. Each new `id` asks
   * once, so focus stays in the list while the keyboard moves through folders.
   */
  focusRequest?: { id: number; path: string | null };
  /**
   * The rows belong to the folder or search left behind while the next one loads. They stay
   * in view so the list does not jump, but take no input, so none acts under the new place.
   */
  stale?: boolean;
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

  // A focus request picks its row while rendering; the effect below moves focus there.
  const [handledRequest, setHandledRequest] = useState<number | null>(null);
  if (focusRequest && focusRequest.id !== handledRequest && rows.length > 0) {
    const index = rows.findIndex((row) => row.path === focusRequest.path);
    setHandledRequest(focusRequest.id);
    setFocused({ key: restoreKey, index: Math.max(0, index) });
  }
  const appliedRequest = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (handledRequest === null || appliedRequest.current === handledRequest)
      return;
    appliedRequest.current = handledRequest;
    pendingFocus.current = focusIndex;
    virtual.revealRow(EntryLayout.rowOf(layout, focusIndex));
  });

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
      aria-busy={stale}
      inert={stale}
      className={cn("relative transition-opacity", stale && "opacity-50")}
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
          row.eligibility.kind === "refused" ? row.eligibility.reason : null;
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
                {DropTarget.labels[blocked]}
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
