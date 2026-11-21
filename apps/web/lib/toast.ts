import type { ReactNode } from "react";

/**
 * A button on a toast, such as Undo. Choosing it runs `run` and closes the toast, unless it
 * `keepsToast`, as Details does: then the toast stays, its time held until the promise `run`
 * returns settles, such as when the dialog it opened closes, and its other actions within reach.
 */
export type ToastAction =
  | { label: string; run: () => void; keepsToast?: never }
  | { label: string; run: () => Promise<unknown>; keepsToast: true };

/** A toast as callers ask for it; the toast UI decides how it looks. */
export type ToastRequest = {
  title: ReactNode;
  /** `loading`: something still under way, shown until replaced or dismissed. */
  type?: "success" | "error" | "loading";
  actions?: readonly ToastAction[];
  /** Replaces the toast shown under the same id, such as a progress entry, instead of adding one. */
  id?: string;
};

type ToastOptions = Pick<ToastRequest, "actions">;

type Show = (request: ToastRequest) => void;
type Dismiss = (id: string) => void;

let ui: { show: Show; dismiss: Dismiss } | null = null;
const pending: ToastRequest[] = [];

function add(request: ToastRequest) {
  if (ui) ui.show(request);
  else pending.push(request);
}

/** Close the toast shown under `id`, or keep it from showing at all. */
export function dismissToast(id: string) {
  if (ui) ui.dismiss(id);
  else
    for (let index = pending.length - 1; index >= 0; index--)
      if (pending[index]?.id === id) pending.splice(index, 1);
}

/**
 * Shows a toast through the app's `Toaster`: `toast(message)`, or `toast.success(message)` and
 * `toast.error(message)` for an outcome, optionally with `actions` such as Undo. Callable from anywhere, including outside React. The
 * toast UI loads after the page, so toasts asked for before it has mounted wait here for it.
 */
export const toast = Object.assign(
  (title: ReactNode, options?: ToastOptions) => add({ title, ...options }),
  {
    success: (title: ReactNode, options?: ToastOptions) =>
      add({ title, type: "success", ...options }),
    error: (title: ReactNode, options?: ToastOptions) =>
      add({ title, type: "error", ...options }),
    /** Something still under way, under `id`, until another toast with it or `dismissToast`. */
    loading: (title: ReactNode, id: string) =>
      add({ title, type: "loading", id }),
  },
);

/**
 * Connects the mounted toast UI: shows the toasts that waited for it, in order, then each new
 * one as it is asked for. Returns the function that disconnects it again.
 */
export function connectToasts(
  next: Show,
  dismiss: Dismiss = () => undefined,
): () => void {
  const connected = { show: next, dismiss };
  ui = connected;
  for (const request of pending.splice(0)) next(request);
  return () => {
    if (ui === connected) ui = null;
  };
}
