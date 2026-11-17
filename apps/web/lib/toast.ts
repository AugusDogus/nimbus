import type { ReactNode } from "react";

/** A toast as callers ask for it; the toast UI decides how it looks. */
export type ToastRequest = { title: ReactNode; type?: "success" | "error" };

type Show = (request: ToastRequest) => void;

let show: Show | null = null;
const pending: ToastRequest[] = [];

function add(request: ToastRequest) {
  if (show) show(request);
  else pending.push(request);
}

/**
 * Shows a toast through the app's `Toaster`: `toast(message)`, or `toast.success(message)` and
 * `toast.error(message)` for an outcome. Callable from anywhere, including outside React. The
 * toast UI loads after the page, so toasts asked for before it has mounted wait here for it.
 */
export const toast = Object.assign((title: ReactNode) => add({ title }), {
  success: (title: ReactNode) => add({ title, type: "success" }),
  error: (title: ReactNode) => add({ title, type: "error" }),
});

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
