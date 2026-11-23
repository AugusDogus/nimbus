import type { PaneSide } from "../split-layout";

/**
 * The folders each pane showed before its current one, for the pane's own Back button, and the
 * folders it shows now. A pane that returns to the folder last left, by its Back button or the
 * browser's, takes it off the list.
 */
export type PaneHistory = {
  shown: Record<PaneSide, string>;
  earlier: Record<PaneSide, readonly string[]>;
};

const sides: readonly PaneSide[] = ["left", "right"];

export const PaneHistory = {
  start: (shown: Record<PaneSide, string>): PaneHistory => ({
    shown,
    earlier: { left: [], right: [] },
  }),

  /** The history once the panes show `shown`; the same history when nothing moved. */
  advance(history: PaneHistory, shown: Record<PaneSide, string>): PaneHistory {
    if (sides.every((side) => history.shown[side] === shown[side]))
      return history;
    const earlier = { ...history.earlier };
    for (const side of sides) {
      const before = history.shown[side];
      if (before === shown[side]) continue;
      const list = earlier[side];
      earlier[side] =
        list.at(-1) === shown[side] ? list.slice(0, -1) : [...list, before];
    }
    return { shown, earlier };
  },

  /** The folder a pane's Back button opens, or null when it has not moved. */
  back: (history: PaneHistory, side: PaneSide) =>
    history.earlier[side].at(-1) ?? null,
} as const;
