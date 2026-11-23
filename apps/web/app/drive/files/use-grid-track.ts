import { useLayoutEffect, useState, type RefObject } from "react";
import { EntryLayout, type EntryTrack } from "./entry-layout";

/** Before the listing is measured, such as in server-rendered markup: a desktop-wide listing. */
const unmeasured = 1100;

/**
 * The grid's columns and row height for the listing's own width, not the window's: a pane of a
 * split view and a page's one folder follow the same rule, and only the number per row differs.
 * Measured before the first paint and again whenever the listing's width changes.
 */
export function useGridTrack(
  listing: RefObject<HTMLElement | null>,
  active: boolean,
): EntryTrack {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = listing.current;
    if (!active || !element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [listing, active]);
  return EntryLayout.gridTrack(width ?? unmeasured);
}
