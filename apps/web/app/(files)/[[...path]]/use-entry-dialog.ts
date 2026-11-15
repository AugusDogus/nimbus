import { useCallback, useState } from "react";
import type { EntryDialog } from "./entry-dialogs";

/**
 * The open entry dialog (preview, rename, move, delete, share) for one view.
 * It belongs to the view it was opened in, so navigating elsewhere closes it.
 * Opening a preview records the visit under Recent.
 */
export function useEntryDialog(scope: string, recordVisit: (path: string) => Promise<void>) {
  const [open, setOpen] = useState<{ scope: string; dialog: EntryDialog } | null>(null);
  const select = useCallback(
    (dialog: EntryDialog | null) => {
      setOpen(dialog === null ? null : { scope, dialog });
      if (dialog?.action === "preview") void recordVisit(dialog.entry.path);
    },
    [scope, recordVisit],
  );
  return { selection: open?.scope === scope ? open.dialog : null, select };
}
