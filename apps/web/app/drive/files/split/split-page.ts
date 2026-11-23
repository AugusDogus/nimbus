import { useEffect, useLayoutEffect, useRef } from "react";
import { useSidebar } from "@/components/ui/sidebar";

/**
 * Whether a split view folded the sidebar to fit its panes, to open it again when the split
 * closes. Kept across the split view's remounts, such as when a pane opens the drive root.
 */
let folded = false;
/** Whether this split view has folded the sidebar once already: it does not fold it again. */
let asked = false;
let unfold: ReturnType<typeof setTimeout> | null = null;

/**
 * Folds the sidebar to its icons when that alone makes room for two panes (`fits`), once per split,
 * and opens it again when the split closes, unless the person opened it again themselves.
 */
export function useSidebarFold(fits: boolean) {
  const sidebar = useSidebar();
  const latest = useRef(sidebar);
  useLayoutEffect(() => {
    latest.current = sidebar;
  });
  const fold = fits && sidebar.open && !sidebar.isMobile && !asked;
  useLayoutEffect(() => {
    if (!fold) return;
    asked = true;
    folded = true;
    latest.current.setOpen(false);
  }, [fold]);
  // Opened again by the person: theirs from now on.
  useEffect(() => {
    if (sidebar.open && !fold) folded = false;
  }, [sidebar.open, fold]);
  useLayoutEffect(() => {
    if (unfold !== null) clearTimeout(unfold);
    unfold = null;
    // A remount follows in the same update, so the sidebar opens only once no split view does.
    return () => {
      unfold = setTimeout(() => {
        unfold = null;
        if (folded && !latest.current.open) latest.current.setOpen(true);
        folded = false;
        asked = false;
      });
    };
  }, []);
  return { foldedForSplit: fold || (folded && !sidebar.open) };
}
