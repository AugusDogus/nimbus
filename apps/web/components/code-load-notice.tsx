import { XIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { CodeLoad, type CodeLoadFailure } from "@/lib/code-load";

/**
 * Keeps the toasts, which share the notice's corner, stacked above it while it shows (see
 * `ToastViewport`), 14px apart as toasts are.
 */
function makeRoomForToasts(card: HTMLDivElement) {
  const root = document.documentElement.style;
  const observer = new ResizeObserver(() =>
    root.setProperty("--code-load-clearance", `${card.offsetHeight + 14}px`),
  );
  observer.observe(card);
  return () => {
    observer.disconnect();
    root.removeProperty("--code-load-clearance");
  };
}

function Notice({ kind }: { kind: CodeLoadFailure }) {
  return (
    <div
      ref={makeRoomForToasts}
      data-slot="code-load-notice"
      className="pointer-events-auto flex items-center gap-2 rounded-(--radius) border bg-popover py-2.5 pr-2.5 pl-4 text-[13px] text-popover-foreground shadow-[0_4px_12px_rgba(0,0,0,0.1)] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2"
    >
      <p className="min-w-0 flex-1 leading-[1.5] font-medium text-pretty">
        {CodeLoad.message(kind)}
      </p>
      <Button
        size="sm"
        className="touch-hit shrink-0"
        onClick={() => location.reload()}
      >
        Reload
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Dismiss"
        title="Dismiss"
        className="touch-hit shrink-0 text-muted-foreground hover:text-foreground"
        onClick={CodeLoad.dismiss}
      >
        <XIcon aria-hidden="true" />
      </Button>
    </div>
  );
}

/**
 * Says that code something asked for did not load, because Nimbus was updated or loading kept
 * failing, with Reload. It sits where toasts do, which stack above it, and above dialogs, whose
 * content may be what failed. Part of every page's startup code, unlike the toasts, so it never
 * depends on code that can go missing. Reload goes through the page's leave warnings, such as for
 * a running upload or unsaved text.
 *
 * Both live regions are always there, so a dialog that opens leaves them to screen readers, and
 * a notice that appears in one is read out: politely for an update, at once for a failure.
 */
export function CodeLoadNotice() {
  const notice = useSyncExternalStore(
    CodeLoad.watch,
    CodeLoad.notice,
    () => null,
  );
  return (
    <div className="pointer-events-none fixed right-6 bottom-[calc(max(1.5rem,env(safe-area-inset-bottom))+var(--impersonation-offset,0px)+var(--toast-clearance,0px))] z-[999999999] w-[356px] max-[600px]:right-4 max-[600px]:bottom-[calc(max(1rem,env(safe-area-inset-bottom))+var(--impersonation-offset,0px)+var(--toast-clearance,0px))] max-[600px]:left-4 max-[600px]:w-auto">
      <div role="status" aria-live="polite">
        {notice === "updated" && <Notice kind="updated" />}
      </div>
      <div role="alert" aria-live="assertive">
        {notice === "unavailable" && <Notice kind="unavailable" />}
      </div>
    </div>
  );
}
