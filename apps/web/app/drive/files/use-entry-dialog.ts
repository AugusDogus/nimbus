import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EntryDialog } from "./entry-dialogs";
import type { TransferResult } from "./transfer-result";

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

/**
 * The open entry dialog (preview, rename, move, delete, share) for one view.
 * It belongs to the view it was opened in, so navigating elsewhere closes it.
 * Opening a preview records the visit under Recent.
 */
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

/**
 * Name clashes from moves made without the picker (a drop on a folder row or a breadcrumb,
 * Move up one level) open the picker at the destination, showing the clashes with the same
 * choices: rename, keep both, skip. A page's file actions are created before its dialog, so
 * they reach it through this hand-off: pass `onClashes` to `useFileActions`, then connect the
 * page's dialog with `useClashChoices`.
 */
export function useClashHandoff() {
  const target = useRef<((result: TransferResult) => void) | null>(null);
  return useMemo(
    () => ({
      onClashes: (result: TransferResult) => target.current?.(result),
      /** Send clashes to `choose` from now on. */
      connect: (choose: (result: TransferResult) => void) => {
        target.current = choose;
      },
    }),
    [],
  );
}

/** Opens `select`'s picker for the clashes `handoff` receives. */
export function useClashChoices(
  handoff: ReturnType<typeof useClashHandoff>,
  select: (dialog: EntryDialog) => void,
) {
  useEffect(() => {
    handoff.connect((result) => select({ action: "clashes", result }));
  }, [handoff, select]);
}
