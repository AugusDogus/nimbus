import { useEffect, useRef, useState } from "react";
import { UserRoundCog } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Where an administrator returns after impersonating: the page the action lives on. */
const returnTo = "/settings/admin";

/**
 * Shown on every signed-in page while an administrator is signed in as someone else.
 * It loads after the app's first render, with the toast area, so no first load carries it.
 */
export default function ImpersonationBanner({ email }: { email: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      window.location.assign(returnTo);
    } catch {
      setError(
        "The server could not be reached. You are still signed in as this person. Try again.",
      );
      setBusy(false);
    }
  };
  return (
    <section
      ref={banner}
      aria-label="Impersonation"
      className="fixed inset-x-4 bottom-4 z-40 mx-auto flex max-w-xl flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-amber-400 px-4 py-3 text-sm text-amber-950 shadow-lg ring-1 ring-amber-950/20 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <UserRoundCog className="size-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-pretty" role="status">
        You are signed in as <strong className="break-all">{email}</strong>.
        Everything you do is recorded under your name.
      </p>
      <Button
        size="sm"
        className="bg-amber-950 text-amber-50 hover:bg-amber-950/90"
        disabled={busy}
        onClick={() => void stop()}
      >
        {busy ? "Returning…" : "Stop impersonating"}
      </Button>
      {error && (
        <p role="alert" className="w-full text-pretty font-medium">
          {error}
        </p>
      )}
    </section>
  );
}
