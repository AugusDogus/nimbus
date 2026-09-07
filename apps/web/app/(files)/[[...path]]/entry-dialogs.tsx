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
import type { FileEntry } from "./types";
import type { useFileActions } from "./use-file-actions";

export type EntryDialog = {
  action: "rename" | "move" | "delete" | "share" | "preview";
  entry: FileEntry;
};

export function EditEntryDialog({
  selection,
  actions,
  onClose,
}: {
  selection: EntryDialog;
  actions: ReturnType<typeof useFileActions>;
  onClose: () => void;
}) {
  const { entry, action } = selection;
  const [name, setName] = useState(entry.name);
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const folders = useQuery({
    queryKey: ["files.list", destination, false],
    queryFn: () => trpcClient.files.list.query({ path: destination }),
    enabled: action === "move",
  });
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (action === "delete") await actions.deleteEntry(entry.path);
      if (action === "rename" && name.trim() !== entry.name)
        await actions.renameEntry(entry.path, name.trim());
      if (action === "move") await actions.moveEntry(entry.path, destination);
      onClose();
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
  if (action === "delete")
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
              “{entry.name}” will stay in trash for 30 days. Its share links and
              direct permissions will be removed.
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
                void submit();
              }}
            >
              Move to trash
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
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
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-balance">
              {action === "rename" ? "Rename" : "Move"}
            </DialogTitle>
            <DialogDescription>
              {entry.name}. Existing share links and direct grants will be
              removed after the change.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-4">
            {action === "rename" ? (
              <>
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
              </>
            ) : (
              <>
                <p className="break-all text-sm">
                  Destination: {destination || "My Drive"}
                </p>
                {destination && (
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() =>
                      setDestination(
                        destination.split("/").slice(0, -1).join("/"),
                      )
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
                  ) : folders.data.filter(
                      (folder) =>
                        folder.type === "dir" && folder.path !== entry.path,
                    ).length === 0 ? (
                    <p className="p-2 text-sm text-muted-foreground">
                      No subfolders
                    </p>
                  ) : (
                    folders.data
                      .filter(
                        (folder) =>
                          folder.type === "dir" && folder.path !== entry.path,
                      )
                      .map((folder) => (
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
              </>
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
            <Button disabled={busy || (action === "rename" && !name.trim())}>
              {action === "rename" ? "Rename" : "Move here"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
