import type { ReactNode } from "react";
import { toast as toastManager } from "@/components/ui/toast";

/**
 * Shows a toast through the app's `Toaster`: `toast(message)`, or `toast.success(message)` and
 * `toast.error(message)` for an outcome. Callable from anywhere, including outside React.
 */
export const toast = Object.assign(
  (title: ReactNode) => toastManager.add({ title }),
  {
    success: (title: ReactNode) => toastManager.add({ title, type: "success" }),
    error: (title: ReactNode) => toastManager.add({ title, type: "error" }),
  },
);
