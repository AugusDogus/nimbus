import { lazyComponent } from "@/components/lazy-component";
import type { TransferResult } from "./transfer-result";
import type { FileEntry } from "./types";
import type { useFileActions } from "./use-file-actions";

// The picker loads when it is first opened, not with the page.
const DestinationPicker = lazyComponent(
  () => import("./destination-picker/destination-picker"),
);

/** The rename and move-to-trash dialogs, loaded when one is first opened. */
export const EditEntryDialog = lazyComponent(
  () => import("./edit-entry-dialog"),
);

/** Dialogs opened from entry menus, the selection bar, and keyboard shortcuts. */
export type EntryDialog =
  | { action: "preview"; entry: FileEntry }
  | { action: "share"; entry: FileEntry }
  | { action: "versions"; entry: FileEntry }
  | { action: "rename"; entry: FileEntry }
  | { action: "move"; entries: readonly FileEntry[] }
  | { action: "copy"; entries: readonly FileEntry[] }
  /** Name clashes of a move made without the picker, for the person to decide. */
  | { action: "clashes"; result: TransferResult }
  | { action: "delete"; entries: readonly FileEntry[] };

/**
 * The move or copy picker of a page, when `dialog` opens one. Pages render it beside their
 * listing, not inside it: a move can empty the listing, and the picker must stay to report
 * what failed.
 */
export function TransferDialog({
  dialog,
  actions,
  onClose,
}: {
  dialog: EntryDialog | null;
  actions: ReturnType<typeof useFileActions>;
  onClose: () => void;
}) {
  if (dialog?.action === "clashes")
    return (
      <DestinationPicker
        operation={dialog.result.operation}
        entries={dialog.result.clashes.map((clash) => clash.source)}
        resume={dialog.result}
        actions={actions}
        onClose={onClose}
      />
    );
  if (dialog?.action !== "move" && dialog?.action !== "copy") return null;
  return (
    <DestinationPicker
      operation={dialog.action}
      entries={dialog.entries}
      actions={actions}
      onClose={onClose}
    />
  );
}
