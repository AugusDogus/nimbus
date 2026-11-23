import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { AppFrame } from "@/components/app-frame";
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
    // rounding it first would round some cards' height the other way.
    const measure = () => {
      latest.current = element.getBoundingClientRect().width;
      if (!held.current) setWidth(latest.current);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [listing, active]);
  return {
    ...EntryLayout.gridTrack(width ?? unmeasured),
    heldWidth: moving ? width : null,
  };
}
