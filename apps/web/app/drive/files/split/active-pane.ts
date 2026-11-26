import { useSyncExternalStore } from "react";
import type { PaneSide } from "../split-layout";

/**
 * Which pane of the split view commands act on, as the person sees it now. The address records
 * it too (`SplitLayout.active`), for links and reloads, but writing the address re-renders the
 * page: a swipe or a tap shows its pane here first, so only what marks the active pane redraws,
 * never the listings, and the address follows once the panes have settled. The page sets it from
 * the address whenever that changes; null without a split view.
 */
let current: PaneSide | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const ActivePane = {
  get: (): PaneSide | null => current,
  set(side: PaneSide | null) {
    if (side === current) return;
    current = side;
    for (const listener of listeners) listener();
  },
  subscribe,
  /** The active pane, re-rendering the caller alone when it changes. */
  use: (): PaneSide | null =>
    useSyncExternalStore(
      subscribe,
      () => current,
      () => null,
    ),
  /** Whether `side` is the active pane; false for the page's one folder (`null`). */
  useIs: (side: PaneSide | null): boolean =>
    useSyncExternalStore(
      subscribe,
      () => side !== null && current === side,
      () => false,
    ),
} as const;
