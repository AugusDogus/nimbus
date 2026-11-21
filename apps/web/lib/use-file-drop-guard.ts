import { useEffect } from "react";
import { LeaveGuard } from "./leave-guard";

/**
 * Keeps a file dropped outside an upload area, or where uploading is not allowed, from opening
 * in the tab, which would leave the page and end running uploads. Upload areas handle and cancel
 * the drag events first; anything they leave is cancelled here and shown as not droppable.
 */
export function useFileDropGuard() {
  useEffect(() => {
    const guard = (event: DragEvent) => {
      if (
        event.defaultPrevented ||
        !event.dataTransfer?.types.includes("Files")
      )
        return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "none";
    };
    addEventListener("dragover", guard);
    addEventListener("drop", guard);
    return () => {
      removeEventListener("dragover", guard);
      removeEventListener("drop", guard);
    };
  }, []);
}

/** Asks before the page is left while `active`, such as while uploads are running. */
export function useLeaveWarning(active: boolean) {
  useEffect(() => (active ? LeaveGuard.hold() : undefined), [active]);
}
