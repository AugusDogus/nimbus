import { useLayoutEffect, useState } from "react";

/** The search's clearance from each of the header's parts, in pixels. */
const gap = 16;

/**
 * Keeps the header's measurements that place its search (see `PageLayout.filesHeader`) up to
 * date: its own left edge and the edges of its left and right parts, in the window's coordinates.
 * The header resizes on every frame the sidebar moves, so the search keeps its place on the window
 * throughout, and gives way only where those parts come within reach.
 */
export function useHeaderEdges() {
  const [header, setHeader] = useState<HTMLElement | null>(null);
  const [start, setStart] = useState<HTMLElement | null>(null);
  const [end, setEnd] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!header || !start || !end) return;
    const update = () => {
      const set = (name: string, px: number) =>
        header.style.setProperty(name, `${px}px`);
      set("--header-left", header.getBoundingClientRect().left);
      set("--start-edge", start.getBoundingClientRect().right + gap);
      set("--end-edge", end.getBoundingClientRect().left - gap);
    };
    update();
    const observer = new ResizeObserver(update);
    for (const element of [header, start, end]) observer.observe(element);
    return () => observer.disconnect();
  }, [header, start, end]);
  // Attach these to the header, its left part and its right part.
  return [setHeader, setStart, setEnd] as const;
}
