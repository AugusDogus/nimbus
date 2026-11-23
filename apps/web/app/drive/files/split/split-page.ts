import { useLayoutEffect, useRef } from "react";
import { AppFrame } from "@/components/app-frame";
import { useSidebar } from "@/components/ui/sidebar";

/** Whether this split view has folded the sidebar once already: it does not fold it again. */
let asked = false;
let unfold: ReturnType<typeof setTimeout> | null = null;

/**
 * Folds the sidebar away when that alone makes room for two panes (`fits`), once per split, and
 * brings it back when the split closes. The fold is not the person's choice, so it is not
 * remembered, and their own toggle ends it (see `AppFrame.useFold`).
 */
export function useSidebarFold(fits: boolean) {
  const sidebar = useSidebar();
  const frame = AppFrame.useFold();
  const latest = useRef(frame);
  useLayoutEffect(() => {
    latest.current = frame;
  });
  const fold = fits && sidebar.open && !sidebar.isMobile && !asked;
  useLayoutEffect(() => {
    if (!fold) return;
    asked = true;
    latest.current.setFolded(true);
  }, [fold]);
  useLayoutEffect(() => {
    if (unfold !== null) clearTimeout(unfold);
    unfold = null;
    // A remount follows in the same update, so the sidebar returns only once no split view does.
    return () => {
      unfold = setTimeout(() => {
        unfold = null;
        latest.current.setFolded(false);
        asked = false;
      });
    };
  }, []);
  return { foldedForSplit: fold || frame.folded };
}
