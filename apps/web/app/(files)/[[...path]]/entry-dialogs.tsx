"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
import { trpcClient } from "@/lib/trpc";
import { FileEntry } from "./types";
import type { useFileActions } from "./use-file-actions";

/** Dialogs opened from entry menus, the selection bar, and keyboard shortcuts. */
export type EntryDialog =
  | { action: "preview"; entry: FileEntry }
  | { action: "share"; entry: FileEntry }
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
  dialog: Exclude<EntryDialog, { action: "preview" | "share" }>;
  actions: ReturnType<typeof useFileActions>;
  onClose: () => void;
}) {
  if (dialog.action === "rename")
    return <RenameDialog entry={dialog.entry} actions={actions} onClose={onClose} />;
  if (dialog.action === "delete")
    return <TrashDialog entries={dialog.entries} actions={actions} onClose={onClose} />;
  return (
    <DestinationDialog
      action={dialog.action}
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
            permissions will be removed.
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
            onClick={(event) => {
              event.preventDefault();
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
              {entry.name}. Existing share links and direct grants will be
              removed after the change.
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
            <Button disabled={busy || !name.trim()}>Rename</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DestinationDialog({
  action,
  entries,
  actions,
  onClose,
}: {
  action: "move" | "copy";
  entries: readonly FileEntry[];
  actions: ReturnType<typeof useFileActions>;
  onClose: () => void;
}) {
  const [destination, setDestination] = useState("");
  const { busy, error, submit } = useSubmit(onClose);
  const sources = new Set(entries.map((entry) => entry.path));
  const folders = useQuery({
    queryKey: ["files.list", destination, false],
    queryFn: () => trpcClient.files.list.query({ path: destination }),
  });
  const choices = (folders.data ?? []).filter(
    (folder) => folder.type === "dir" && !sources.has(folder.path),
  );
  const destinationEntry: FileEntry = {
    name: destination.split("/").pop() || "My Drive",
    path: destination,
    type: "dir",
    // The server checks write access when the change is submitted.
    permission: "write",
    mtime: null,
    size: null,
  };
  const blocked =
    action === "move" &&
    entries.some((entry) => !FileEntry.canMoveInto(entry, destinationEntry));
  const verb = action === "move" ? "Move" : "Copy";
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
              const [entry, ...rest] = entries;
              if (action === "move" && entry && rest.length === 0) {
                await actions.moveEntry(entry.path, destination);
                return true;
              }
              // The summary toast reports partial failures.
              if (action === "move") await actions.moveEntries(entries, destination);
              else await actions.copyEntries(entries, destination);
              return true;
            });
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-balance">
              {entries.length === 1 ? verb : `${verb} ${subject(entries)}`}
            </DialogTitle>
            <DialogDescription>
              {entries.length === 1 && entries[0] ? `${entries[0].name}. ` : ""}
              {action === "move"
                ? "Existing share links and direct grants will be removed after the move."
                : "Copies use the destination folder's permissions. Name clashes get a number."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-4">
            <p className="break-all text-sm">
              Destination: {destination || "My Drive"}
            </p>
            {destination && (
              <Button
                variant="outline"
                type="button"
                onClick={() =>
                  setDestination(destination.split("/").slice(0, -1).join("/"))
                }
              >
                Parent folder
              </Button>
            )}
            <div className="max-h-56 overflow-auto rounded-md border p-2">
              {folders.isPending ? (
                <p className="p-2 text-sm">Loading folders…</p>
              ) : folders.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  {folders.error.message}
                </p>
              ) : choices.length === 0 ? (
                <p className="p-2 text-sm text-muted-foreground">
                  No subfolders
                </p>
              ) : (
                choices.map((folder) => (
                  <Button
                    key={folder.path}
                    variant="ghost"
                    type="button"
                    className="w-full justify-start"
                    onClick={() => setDestination(folder.path)}
                  >
                    {folder.name}
                  </Button>
                ))
              )}
            </div>
            {blocked && (
              <p className="text-pretty text-sm text-muted-foreground">
                Choose a folder other than the current location of these items.
              </p>
            )}
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
            <Button disabled={busy || blocked}>{verb} here</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
