import type { ReactNode } from "react";

/**
 * A button on a toast, such as Undo. Choosing it runs `run` and closes the toast, unless it
 * `keepsToast`, as Details does, so the toast's other actions stay within reach.
 */
export type ToastAction = { label: string; run: () => void; keepsToast?: true };

/** A toast as callers ask for it; the toast UI decides how it looks. */
export type ToastRequest = {
  title: ReactNode;
  type?: "success" | "error";
  actions?: readonly ToastAction[];
  /** Stays until closed, as a toast whose actions there is no hurry to reach does. */
  persistent?: true;
};

type ToastOptions = Pick<ToastRequest, "actions" | "persistent">;

type Show = (request: ToastRequest) => void;

let show: Show | null = null;
const pending: ToastRequest[] = [];

function add(request: ToastRequest) {
  if (show) show(request);
  else pending.push(request);
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
  },
);

/**
 * Connects the mounted toast UI: shows the toasts that waited for it, in order, then each new
 * one as it is asked for. Returns the function that disconnects it again.
 */
export function connectToasts(next: Show): () => void {
  show = next;
  for (const request of pending.splice(0)) next(request);
  return () => {
    if (show === next) show = null;
  };
}
