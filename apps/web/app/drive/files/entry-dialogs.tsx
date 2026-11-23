import { useRef, useState } from "react";
import { lazyComponent } from "@/components/lazy-component";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PinnedPlace } from "./destination-picker/destination-picker";
import type { TransferResult } from "./transfer-result";
import type { FileEntry } from "./types";
import type { useFileActions } from "./use-file-actions";

// The picker loads when it is first opened, not with the page.
const DestinationPicker = lazyComponent(
  () => import("./destination-picker/destination-picker"),
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

const subject = (entries: readonly FileEntry[]) =>
  entries.length === 1 && entries[0]
    ? `“${entries[0].name}”`
    : `${entries.length.toLocaleString()} items`;

export function EditEntryDialog({
  dialog,
  actions,
  onClose,
}: {
  dialog: Extract<EntryDialog, { action: "rename" | "delete" }>;
  actions: ReturnType<typeof useFileActions>;
  onClose: () => void;
}) {
  if (dialog.action === "rename")
    return (
      <RenameDialog entry={dialog.entry} actions={actions} onClose={onClose} />
    );
  return (
    <TrashDialog entries={dialog.entries} actions={actions} onClose={onClose} />
  );
}

/**
 * The move or copy picker of a page, when `dialog` opens one. Pages render it beside their
 * listing, not inside it: a move can empty the listing, and the picker must stay to report
 * what failed.
 */
export function TransferDialog({
  dialog,
  actions,
  onClose,
  pinned,
}: {
  dialog: EntryDialog | null;
  actions: ReturnType<typeof useFileActions>;
  onClose: () => void;
  /** Places listed first in the picker, such as the other pane's folder in a split view. */
  pinned?: readonly PinnedPlace[];
}) {
  if (dialog?.action === "clashes")
    return (
      <DestinationPicker
        operation={dialog.result.operation}
        entries={dialog.result.clashes.map((clash) => clash.source)}
        resume={dialog.result}
        actions={actions}
        onClose={onClose}
        pinned={pinned}
      />
    );
  if (dialog?.action !== "move" && dialog?.action !== "copy") return null;
  return (
    <DestinationPicker
      operation={dialog.action}
      entries={dialog.entries}
      actions={actions}
      onClose={onClose}
      pinned={pinned}
    />
  );
}

function useSubmit(onClose: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (run: () => Promise<boolean>) => {
    setBusy(true);
    setError(null);
    try {
      if (await run()) onClose();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The change could not be saved. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

function TrashDialog({
  entries,
  actions,
  onClose,
}: {
  entries: readonly FileEntry[];
  actions: ReturnType<typeof useFileActions>;
  onClose: () => void;
}) {
  const { busy, error, submit } = useSubmit(onClose);
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-balance">
            Move to trash?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {subject(entries)} will stay in trash for 30 days.{" "}
            {entries.length === 1 ? "Its" : "Their"} share links and direct
            permissions stop working until{" "}
            {entries.length === 1 ? "it is" : "they are"} restored.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={() => {
              void submit(async () => {
                const [entry, ...rest] = entries;
                if (entry && rest.length === 0) {
                  await actions.deleteEntry(entry.path);
                  return true;
                }
                // The summary toast reports partial failures; the dialog has nothing left to do.
                await actions.trashEntries(entries);
                return true;
              });
            }}
          >
            Move to trash
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RenameDialog({
  entry,
  actions,
  onClose,
}: {
  entry: FileEntry;
  actions: ReturnType<typeof useFileActions>;
  onClose: () => void;
}) {
  const [name, setName] = useState(entry.name);
  const { busy, error, submit } = useSubmit(onClose);
  // Only the field's first focus selects the name without its extension. Focus that comes back
  // after the person started must not narrow what they selected, or the extension would be typed
  // twice.
  const stemSelected = useRef(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(async () => {
              if (name.trim() !== entry.name)
                await actions.renameEntry(entry.path, name.trim());
              return true;
            });
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-balance">Rename</DialogTitle>
            <DialogDescription>
              {entry.name}. Share links, direct permissions, and stars stay with
              it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-4">
            <Label htmlFor="entry-name">Name</Label>
            <Input
              id="entry-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              onFocus={(event) => {
                if (stemSelected.current) return;
                stemSelected.current = true;
                const dot =
                  entry.type === "file"
                    ? event.target.value.lastIndexOf(".")
                    : -1;
                event.target.setSelectionRange(
                  0,
                  dot > 0 ? dot : event.target.value.length,
                );
              }}
            />
            {error && (
              <p role="alert" className="text-pretty text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="tertiary"
              type="button"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
