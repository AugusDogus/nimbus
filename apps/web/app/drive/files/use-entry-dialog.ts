import { useCallback, useState } from "react";
import type { EntryDialog } from "./entry-dialogs";

/**
 * The open entry dialog (preview, rename, move, delete, share) for one view.
 * It belongs to the view it was opened in, so navigating elsewhere closes it.
 * Opening a preview records the visit under Recent.
 */
/**
 * The control that asked for the last dialog: the button of the menu it was chosen from,
 * still marked open while the choice is handled, or else whatever had focus. Read when the
 * dialog was asked for, because a menu moves focus elsewhere as it closes and a dialog that
 * loads on demand mounts after that.
 */
let lastOpener: HTMLElement | null = null;

function openerNow(): HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.closest('[role="menu"]'))
    return document.querySelector<HTMLElement>(
      '[aria-haspopup="menu"][aria-expanded="true"]',
    );
  return active instanceof HTMLElement && active !== document.body
    ? active
    : null;
}

/** Where focus returns when the last dialog closes, while that control is still on the page. */
export const dialogOpener = () => (lastOpener?.isConnected ? lastOpener : null);

export function useEntryDialog(
  scope: string,
  recordVisit: (path: string) => Promise<void>,
) {
  const [open, setOpen] = useState<{
    scope: string;
    dialog: EntryDialog;
  } | null>(null);
  const select = useCallback(
    (dialog: EntryDialog | null) => {
      if (dialog !== null) lastOpener = openerNow();
      setOpen(dialog === null ? null : { scope, dialog });
      if (dialog?.action === "preview") void recordVisit(dialog.entry.path);
    },
    [scope, recordVisit],
  );
  return { selection: open?.scope === scope ? open.dialog : null, select };
}
