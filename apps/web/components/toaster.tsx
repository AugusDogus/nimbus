import { useEffect } from "react";
import {
  Toaster as ToastUI,
  toast as toastManager,
} from "@/components/ui/toast";
import { connectToasts } from "@/lib/toast";

/** Whether a modal dialog, sheet or drawer covers the page, keeping toasts out of reach. */
const covered = () =>
  document.querySelector(
    '[data-slot="dialog-content"], [data-slot="sheet-content"], [data-slot="alert-dialog-content"], [data-slot="drawer-content"]',
  ) !== null;

/**
 * A toast added while a modal covers the page cannot be reached until it closes: its time is
 * held until then, so an Undo that arrives late, under a dialog, is not gone before it is seen.
 */
function holdWhileCovered(id: string, timeout: number) {
  toastManager.update(id, { timeout: 0 });
  const observer = new MutationObserver(() => {
    if (covered()) return;
    observer.disconnect();
    toastManager.update(id, { timeout });
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

/** Connects `toast()` to the UI once its provider listens, which Base UI requires. */
function ConnectToasts() {
  useEffect(
    () =>
      connectToasts(({ actions, ...request }) => {
        // An error may be the only place that says what failed: it stays until closed, and
        // screen readers announce it at once. A toast offering an action such as Undo stays
        // long enough to reach it: ten seconds once no dialog covers it, paused while the
        // toasts are hovered or focused or the window is in the background, and held while a
        // dialog it opened, such as Details, is open (see `ToastAction`).
        const reachFor = request.type !== "error" && actions ? 10_000 : null;
        const id = toastManager.add({
          ...request,
          data: { actions },
          ...(request.type === "error"
            ? { timeout: 0, priority: "high" }
            : reachFor
              ? { timeout: reachFor }
              : {}),
        });
        if (reachFor && covered()) holdWhileCovered(id, reachFor);
      }),
    [],
  );
  return null;
}

/**
 * The app's toast UI, loaded after the page so no page waits for it. Code that shows toasts
 * imports `@/lib/toast`, never this module or the stock component, so nothing at startup does.
 */
export function Toaster() {
  return (
    <>
      <ToastUI />
      {/* After the toaster, so its effect runs once the toaster's provider has subscribed. */}
      <ConnectToasts />
    </>
  );
}
