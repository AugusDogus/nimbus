import { useRef, useState } from "react";
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
import type { EntryDialog } from "./entry-dialogs";
import type { FileEntry } from "./types";
import type { useFileActions } from "./use-file-actions";

const subject = (entries: readonly FileEntry[]) =>
  entries.length === 1 && entries[0]
    ? `“${entries[0].name}”`
    : `${entries.length.toLocaleString()} items`;

export default function EditEntryDialog({
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
  // Only the field's first focus selects the name without its extension. Focus can come back
  // after the person started, such as when the menu that opened the dialog returns it late, and
  // must not narrow what they selected, or the extension would be typed twice.
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
              variant="outline"
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
