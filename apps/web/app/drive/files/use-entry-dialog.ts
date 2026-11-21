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
  // What is open as of the last call, before React renders it: two calls in one tick see it.
  const latest = useRef(open);
  const select = useCallback(
    (dialog: EntryDialog | null) => {
      if (dialog !== null) lastOpener = openerNow();
      const next = dialog === null ? null : { scope, dialog };
      latest.current = next;
      setOpen(next);
      if (dialog?.action === "preview") void recordVisit(dialog.entry.path);
    },
    [scope, recordVisit],
  );
  /** Open `dialog` only when no dialog of this view is open; says whether it did. */
  const offer = useCallback(
    (dialog: EntryDialog) => {
      if (latest.current?.scope === scope) return false;
      select(dialog);
      return true;
    },
    [scope, select],
  );
  return {
    selection: open?.scope === scope ? open.dialog : null,
    select,
    offer,
  };
}

/**
 * Name clashes from moves made without the picker (a drop on a folder row or a breadcrumb,
 * Move up one level) open the picker at the destination, showing the clashes with the same
 * choices: rename, keep both, skip. A page's file actions are created before its dialog, so
 * they reach it through this hand-off: pass `onClashes` to `useFileActions`, then connect the
 * page's dialog with `useClashChoices`. The page takes a move only while it is shown and no
 * other dialog is open; `onClashes` says whether it took it, and a move it did not take is
 * reported instead, so it is never lost.
 */
export function useClashHandoff() {
  const target = useRef<((result: TransferResult) => boolean) | null>(null);
  return useMemo(
    () => ({
      onClashes: (result: TransferResult) => target.current?.(result) ?? false,
      /** Send clashes to `choose` from now on, or to nothing. */
      connect: (choose: ((result: TransferResult) => boolean) | null) => {
        target.current = choose;
      },
    }),
    [],
  );
}

/** Opens a picker with `offer` for the clashes `handoff` receives, while the page is shown. */
export function useClashChoices(
  handoff: ReturnType<typeof useClashHandoff>,
  offer: (dialog: EntryDialog) => boolean,
) {
  useEffect(() => {
    handoff.connect((result) => offer({ action: "clashes", result }));
    return () => handoff.connect(null);
  }, [handoff, offer]);
}
