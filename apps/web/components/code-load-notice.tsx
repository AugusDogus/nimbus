import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { CodeLoad } from "@/lib/code-load";

/**
 * Says that code the page needs did not load: that Nimbus was updated, with Reload, or that
 * loading failed, with Try again. Part of every page's startup code, so it never depends on code
 * that can go missing. Reload goes through the page's leave warnings, such as for a running
 * upload or unsaved text. It sits below the page header and under menus and dialogs, so the
 * account menu and its Sign out stay in reach.
 */
export function CodeLoadNotice() {
  const notice = useSyncExternalStore(
    CodeLoad.watch,
    CodeLoad.notice,
    () => null,
  );
  if (!notice) return null;
  return (
    <div
      role="alert"
      className="fixed inset-x-4 top-20 z-40 mx-auto flex max-w-md flex-wrap items-center gap-x-3 gap-y-2 rounded-(--radius) border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
    >
      <p className="min-w-48 flex-1 text-pretty">{CodeLoad.message(notice)}</p>
      <div className="ml-auto flex gap-2">
        <Button size="sm" variant="ghost" onClick={CodeLoad.dismiss}>
          Dismiss
        </Button>
        {notice === "updated" ? (
          <Button size="sm" onClick={() => location.reload()}>
            Reload
          </Button>
        ) : (
          <Button size="sm" onClick={CodeLoad.retry}>
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}
