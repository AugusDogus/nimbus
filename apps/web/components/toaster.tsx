import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  Toaster as ToastUI,
  toast as toastManager,
  useToastManager,
} from "@/components/ui/toast";
import { connectToasts } from "@/lib/toast";

/**
 * Whether a modal dialog, sheet or drawer covers the page, keeping toasts out of reach. The
 * phone sidebar is a sheet under a slot of its own.
 */
const covered = () =>
  document.querySelector(
    '[data-slot="dialog-content"], [data-slot="sheet-content"], [data-slot="alert-dialog-content"], [data-slot="drawer-content"], [data-slot="sidebar"][data-mobile="true"]',
  ) !== null;

const watchCover = (changed: () => void) => {
  const observer = new MutationObserver(changed);
  observer.observe(document.body, { childList: true, subtree: true });
  return () => observer.disconnect();
};

/**
 * Every toast's time is held while a dialog, sheet or drawer covers the page, since nobody can
 * reach it then, and starts again in full once the page is uncovered: a report or an Undo
 * confirmation, shown before the dialog opened or while it is open, is never gone unseen.
 */
function HoldWhileCovered() {
  const { toasts, update } = useToastManager();
  const isCovered = useSyncExternalStore(watchCover, covered, () => false);
  // The timeouts of the toasts held now, to give back.
  const held = useRef(new Map<string, number | undefined>());
  useEffect(() => {
    if (isCovered) {
      for (const shown of toasts)
        if (
          !held.current.has(shown.id) &&
          shown.timeout !== 0 &&
          shown.type !== "loading" &&
          shown.transitionStatus !== "ending"
        ) {
          held.current.set(shown.id, shown.timeout);
          update(shown.id, { timeout: 0 });
        }
      return;
    }
    for (const [id, timeout] of held.current) update(id, { timeout });
    held.current.clear();
  }, [isCovered, toasts, update]);
  return null;
}

/**
 * What is still under way, such as the entry listing running transfers, stays in view: when
 * newer toasts, such as errors that stay until closed, push it past the limit of toasts shown,
 * it comes back in front of them. Those it displaces return once it is gone.
 */
function KeepWorkInView() {
  const { toasts, add, close } = useToastManager();
  useEffect(() => {
    for (const shown of toasts)
      if (
        shown.type === "loading" &&
        shown.limited &&
        shown.transitionStatus !== "ending"
      ) {
        close(shown.id);
        // Added again under the same id, it replaces the closing one, newest first. Work
        // under way offers no actions, so it carries no data.
        add({ id: shown.id, title: shown.title, type: shown.type });
      }
  }, [toasts, add, close]);
  return null;
}

/** Connects `toast()` to the UI once its provider listens, which Base UI requires. */
function ConnectToasts() {
  useEffect(
    () =>
      connectToasts(
        ({ actions, ...request }) => {
          // An error may be the only place that says what failed: it stays until closed, and
          // screen readers announce it at once. A toast offering an action such as Undo stays
          // long enough to reach it: ten seconds. Every toast's time is paused while the
          // toasts are hovered or focused or the window is in the background, and held while
          // a dialog covers the page (see `HoldWhileCovered`), Details included.
          toastManager.add({
            ...request,
            data: { actions },
            ...(request.type === "error"
              ? { timeout: 0, priority: "high" }
              : actions
                ? { timeout: 10_000 }
                : {}),
          });
        },
        (id) => toastManager.close(id),
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
      <ToastUI>
        <HoldWhileCovered />
        <KeepWorkInView />
      </ToastUI>
      {/* After the toaster, so its effect runs once the toaster's provider has subscribed. */}
      <ConnectToasts />
    </>
  );
}
