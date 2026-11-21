import { useState } from "react";
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
  dialog: Exclude<EntryDialog, { action: "preview" | "share" | "versions" }>;
  actions: ReturnType<typeof useFileActions>;
  onClose: () => void;
}) {
  if (dialog.action === "rename")
    return (
      <RenameDialog entry={dialog.entry} actions={actions} onClose={onClose} />
    );
  if (dialog.action === "delete")
    return (
      <TrashDialog
        entries={dialog.entries}
        actions={actions}
        onClose={onClose}
      />
    );
  return (
    <DestinationPicker
      operation={dialog.action}
      entries={dialog.entries}
      actions={actions}
      onClose={onClose}
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
