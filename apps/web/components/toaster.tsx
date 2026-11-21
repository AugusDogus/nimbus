import { useEffect } from "react";
import {
  Toaster as ToastUI,
  toast as toastManager,
} from "@/components/ui/toast";
import { connectToasts } from "@/lib/toast";

/** Connects `toast()` to the UI once its provider listens, which Base UI requires. */
function ConnectToasts() {
  useEffect(
    () =>
      connectToasts(({ actions, persistent, ...request }) =>
        toastManager.add({
          ...request,
          data: { actions },
          // An error may be the only place that says what failed: it stays until closed, and
          // screen readers announce it at once. A toast offering an action such as Undo stays
          // long enough to reach it.
          ...(request.type === "error"
            ? { timeout: 0, priority: "high" }
            : persistent
              ? { timeout: 0 }
              : actions
                ? { timeout: 10_000 }
                : {}),
        }),
      ),
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
