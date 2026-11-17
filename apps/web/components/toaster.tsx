import { useEffect } from "react";
import {
  Toaster as ToastUI,
  toast as toastManager,
} from "@/components/ui/toast";
import { connectToasts } from "@/lib/toast";

/** Connects `toast()` to the UI once its provider listens, which Base UI requires. */
function ConnectToasts() {
  useEffect(() => connectToasts((request) => toastManager.add(request)), []);
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
