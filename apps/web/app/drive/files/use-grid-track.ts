import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { AppFrame } from "@/components/app-frame";
import { Device } from "@/lib/device";
import { EntryLayout, type EntryTrack } from "./entry-layout";

/** Before the listing is measured, such as in server-rendered markup: a desktop-wide listing. */
const unmeasured = 1100;

/**
 * The grid's columns and row height for the listing's own width, not the window's: a pane of a
 * split view and a page's one folder follow the same rule, and only the number per row differs.
 * Measured before the first paint and again whenever the listing's width changes, except while
 * the sidebar slides: the cards keep their columns through its motion, so no name re-wraps on the
 * way, and take the new width once it has settled.
 */
export function useGridTrack(
  listing: RefObject<HTMLElement | null>,
  active: boolean,
  /**
   * Changes when the listing's place does, as when the page's folder becomes a pane of a split
   * view or stops being one: the cards take the new width in that same update, before it is drawn.
   */
  placeKey?: unknown,
): EntryTrack & {
  /** While the sidebar slides: the width the cards keep, in pixels, until it settles. */
  heldWidth: number | null;
} {
  const [width, setWidth] = useState<number | null>(null);
  const moving = AppFrame.useSidebarMoving();
  const held = useRef(moving);
  const latest = useRef<number | null>(null);
  useLayoutEffect(() => {
    held.current = moving;
    if (!moving && latest.current !== null) setWidth(latest.current);
  }, [moving]);
  useLayoutEffect(() => {
    const element = listing.current;
    if (!active || !element) return;
    // The exact width, fractions included, as the page's skeleton lays its cards out in CSS:
    // rounding it first would round some cards' height the other way. Its laid-out width, not
    // the one on screen: a pane moving in or stepping back is scaled for a while.
    const take = (width: number) => {
      latest.current = width;
      if (!held.current) setWidth(width);
    };
    take(Device.layoutWidth(element));
    // A new width shows in the frame it is laid out in: the cards take it before that frame is
    // painted, rather than a frame later at their old size.
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.borderBoxSize[0]?.inlineSize;
      if (width !== undefined) flushSync(() => take(width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [listing, active, placeKey]);
  return {
    ...EntryLayout.gridTrack(width ?? unmeasured),
    heldWidth: moving ? width : null,
  };
}
