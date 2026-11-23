import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { CodeLoad } from "@/lib/code-load";

/**
 * Says that code the page needs did not load, because Nimbus was updated or loading kept
 * failing, with Reload. Part of every page's startup code, so it never depends on code
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
        <Button size="sm" onClick={() => location.reload()}>
          Reload
        </Button>
      </div>
    </div>
  );
}

/**
 * In place of a preview or other content shown in place whose code did not load. Inside a dialog
 * the notice is out of reach behind it, so this offers Reload itself.
 */
export function CodeLoadFailed() {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-4 text-sm"
    >
      <p className="text-pretty">
        This part of Nimbus could not load. Reload the page to use it.
      </p>
      <Button size="sm" onClick={() => location.reload()}>
        Reload
      </Button>
    </div>
  );
}
