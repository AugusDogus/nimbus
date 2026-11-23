import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { UserRoundCog } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { LeaveGuard } from "@/lib/leave-guard";

/** The element index.html provides for the banner. */
const hostId = "impersonation-banner";

/** Where an administrator returns after impersonating: the page the action lives on. */
const returnTo = "/settings/admin";

/**
 * Shown on every signed-in page while an administrator is signed in as someone else.
 * It loads after the app's first render, with the toast area, so no first load carries it, and
 * renders first in the page so it is first in tab order. Dialogs, at z-50, cover it.
 */
export default function ImpersonationBanner({ email }: { email: string }) {
  // The page provides the banner's place from the start (see index.html): a place created now,
  // while a dialog is open, would escape the dialog hiding the rest of the page from assistive
  // technology. Only a page without one gets a place made here, as before.
  const [host] = useState(() => {
    const provided = document.getElementById(hostId);
    return provided
      ? { element: provided, owned: false }
      : { element: document.createElement("div"), owned: true };
  });
  useLayoutEffect(() => {
    if (!host.owned) return;
    document.body.prepend(host.element);
    return () => host.element.remove();
  }, [host]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Returning changes the session at once, so a transfer, Undo or upload still running as this
  // person could not report or be undone afterwards: while one runs, the administrator is asked
  // first, and the session changes only once they confirm.
  const [asked, setAsked] = useState(false);
  const banner = useRef<HTMLElement>(null);
  // Bottom-anchored controls and scroll areas keep clear of the banner through this offset.
  useEffect(() => {
    const element = banner.current;
    if (!element) return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => {
      const gap = window.innerHeight - element.getBoundingClientRect().top;
      root.style.setProperty("--impersonation-offset", `${Math.ceil(gap)}px`);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--impersonation-offset");
    };
  }, []);
  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/admin/stop-impersonating", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) {
        setError(
          "Nimbus could not return you to your account. Try again, or sign out and sign in as yourself.",
        );
        setBusy(false);
        return;
      }
      // Asked already, when anything was running.
      LeaveGuard.leave(returnTo);
    } catch {
      setError(
        "The server could not be reached. You are still signed in as this person. Try again.",
      );
      setBusy(false);
    }
  };
  return createPortal(
    <section
      ref={banner}
      aria-label="Impersonation"
      className="fixed inset-x-2 bottom-2 z-40 mx-auto flex max-w-xl flex-wrap items-center gap-x-2 gap-y-2 rounded-xl bg-amber-400 px-3 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] text-sm text-amber-950 shadow-lg ring-1 ring-amber-950/20 sm:inset-x-4 sm:bottom-4 sm:gap-x-3 sm:px-4 sm:pt-3 sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <UserRoundCog className="size-4 shrink-0" aria-hidden="true" />
      {/* Wide enough to read in lines: on narrow screens the button wraps below instead. */}
      <p className="min-w-0 flex-1 basis-60 text-pretty" role="status">
        You are signed in as <strong className="break-all">{email}</strong>.
        Everything you do is recorded under your name.
      </p>
      <Button
        size="compact"
        className="w-full bg-amber-950 text-amber-50 hover:bg-amber-950/90 sm:w-auto"
        disabled={busy}
        onClick={() => {
          if (LeaveGuard.busy()) setAsked(true);
          else void stop();
        }}
      >
        {busy ? "Returning…" : "Stop impersonating"}
      </Button>
      {error && (
        <p role="alert" className="w-full text-pretty font-medium">
          {error}
        </p>
      )}
      <AlertDialog open={asked} onOpenChange={setAsked}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-balance">
              Stop impersonating while something is still running?
            </AlertDialogTitle>
            <AlertDialogDescription>
              A move, copy, Undo or upload is still running as this person.
              Stopping now ends it without a report or Undo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep impersonating</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setAsked(false);
                void stop();
              }}
            >
              Stop impersonating
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>,
    host.element,
  );
}
