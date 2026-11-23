import { useLayoutEffect, type RefObject } from "react";

/**
 * While two panes show side by side, the page area gives its surface up to the two pane cards
 * (see `globals.css`) and keeps no room for a scrollbar, since it never scrolls then. The header
 * takes that room into its padding instead (`--split-gutter`), so nothing in it moves.
 */
export function usePageArea(
  frame: RefObject<HTMLElement | null>,
  sideBySide: boolean,
) {
  useLayoutEffect(() => {
    const area = frame.current?.closest<HTMLElement>(
      '[data-slot="sidebar-inset"]',
    );
    if (!sideBySide || !area) return;
    // Measured while the room is still kept: the scrollbar's width, or 0 where scrollbars overlay.
    area.style.setProperty(
      "--split-gutter",
      `${area.offsetWidth - area.clientWidth}px`,
    );
    area.dataset.split = "";
    return () => {
      delete area.dataset.split;
      area.style.removeProperty("--split-gutter");
    };
  }, [frame, sideBySide]);
}
