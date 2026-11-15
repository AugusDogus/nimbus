import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { EntryLayout } from "./entry-layout";

/** Rows rendered beyond the viewport on each side, in pixels. Covers fast flings between frames. */
const overscan = 800;
/** Rows rendered before the browser has measured anything, including during SSR. */
const initialRows = 40;
/**
 * Folders up to this size render every row. Mounting them costs little, and keeping every name in
 * the DOM preserves the browser's find-in-page. Larger folders render only the visible window.
 */
export const fullRenderLimit = 300;

// Scroll positions by folder and view, kept for client-side navigation within this tab.
const savedScroll = new Map<string, number>();
// The first list after a page load hydrates under whatever scroll position the browser or the user
// already set. Later lists come from client-side navigation and start at the top.
let navigated = false;

function scrollParent(element: HTMLElement): HTMLElement {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if (overflowY === "auto" || overflowY === "scroll") return parent;
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : document.documentElement;
}

type Range = { start: number; end: number };

/**
 * Window a fixed-geometry layout against its nearest scrolling ancestor. Returns the row range to
 * render and helpers to reveal a row below sticky headers. `restoreKey` restores the scroll
 * position when returning to a folder and starts new folders at the top.
 */
export function useVirtualRows<T>({
  layout,
  containerRef,
  obstructionRef,
  restoreKey,
}: {
  layout: EntryLayout<T>;
  containerRef: RefObject<HTMLElement | null>;
  /** Sticky content covering the top of the scroller, such as the toolbar. */
  obstructionRef: RefObject<HTMLElement | null>;
  restoreKey: string;
}) {
  const renderAll = layout.entries.length <= fullRenderLimit;
  const [windowed, setRange] = useState<Range>(() => ({ start: 0, end: Math.min(layout.rows.length, initialRows) }));
  const range = renderAll ? { start: 0, end: layout.rows.length } : windowed;
  const scrollerRef = useRef<HTMLElement | null>(null);
  const layoutRef = useRef(layout);
  useLayoutEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  const geometry = useCallback(() => {
    const container = containerRef.current;
    const scroller = scrollerRef.current;
    if (!container || !scroller) return null;
    const offset = container.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const obstruction = obstructionRef.current
      ? Math.max(0, obstructionRef.current.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top)
      : 0;
    return { container, scroller, offset, obstruction };
  }, [containerRef, obstructionRef]);

  const update = useCallback(() => {
    const measured = geometry();
    if (!measured) return;
    const top = measured.scroller.scrollTop - measured.offset;
    const next = EntryLayout.rangeAt(layoutRef.current, top - overscan, top + measured.scroller.clientHeight + overscan);
    setRange((current) => (current.start === next.start && current.end === next.end ? current : next));
  }, [geometry]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scroller = scrollParent(container);
    scrollerRef.current = scroller;
    const saved = savedScroll.get(restoreKey);
    if (saved !== undefined) scroller.scrollTop = saved;
    else if (navigated) scroller.scrollTop = 0;
    navigated = true;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
        savedScroll.set(restoreKey, scroller.scrollTop);
      });
    };
    update();
    scroller.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    observer.observe(container);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      observer.disconnect();
    };
  }, [containerRef, restoreKey, update]);

  // A new layout (sorting, resizing columns, live updates) changes which rows are visible.
  useEffect(update, [layout, update]);

  /** Scroll the minimum distance that shows `rowIndex` fully below sticky content. */
  const revealRow = useCallback(
    (rowIndex: number) => {
      const measured = geometry();
      const row = layoutRef.current.rows[rowIndex];
      if (!measured || !row) return;
      const { scroller, offset, obstruction } = measured;
      const top = offset + row.top;
      const bottom = top + row.height;
      const visibleTop = scroller.scrollTop + Math.min(obstruction, scroller.clientHeight / 2);
      if (top < visibleTop) scroller.scrollTop -= visibleTop - top + 8;
      else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight + 8;
      update();
    },
    [geometry, update],
  );

  /** Rows that fit in the visible area, for PageUp and PageDown. */
  const rowsPerPage = useCallback(() => {
    const measured = geometry();
    const row = layoutRef.current.rows.find((candidate) => candidate.kind === "entries");
    if (!measured || !row) return 1;
    return Math.max(1, Math.floor((measured.scroller.clientHeight - measured.obstruction) / (row.height + 4)));
  }, [geometry]);

  /** Layout coordinates of a viewport point, for hit-testing pointer gestures. */
  const toLayout = useCallback(
    (clientX: number, clientY: number) => {
      const container = containerRef.current;
      if (!container) return null;
      const rect = container.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top, width: rect.width };
    },
    [containerRef],
  );

  return { range, revealRow, rowsPerPage, toLayout, scrollerRef };
}
