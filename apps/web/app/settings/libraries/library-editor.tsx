import { useState } from "react";
import { ArrowDown, ArrowUp, Folder, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpcClient } from "@/lib/trpc";
import { trpcErrorCode } from "@/lib/trpc-error";
import type { Library } from "@/server/libraries/libraries";
import { FolderChooser } from "./folder-chooser";

type View =
  | { kind: "form" }
  | { kind: "choose" }
  /** New folders reach devices already paired: the owner confirms, seeing their names. */
  | { kind: "confirm" };

/** Create a library, or change one's title and folders. */
export function LibraryEditor({
  editing,
  onClose,
  onSaved,
}: {
  editing: { kind: "new" } | { kind: "edit"; library: Library };
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const existing = editing.kind === "edit" ? editing.library : null;
  const [title, setTitle] = useState(existing?.title ?? "");
  const [folders, setFolders] = useState<string[]>(existing?.folders ?? []);
  const [view, setView] = useState<View>({ kind: "form" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (acknowledged: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (existing)
        await trpcClient.libraries.updateLibrary.mutate({
          id: existing.id,
          title,
          folders,
          acknowledgedDevices: acknowledged
            ? existing.devices.map((device) => device.id)
            : [],
        });
      else await trpcClient.libraries.createLibrary.mutate({ title, folders });
      await onSaved();
    } catch (failure) {
      const message =
        failure instanceof Error && failure.message
          ? failure.message
          : "Nimbus could not be reached. Nothing was saved; try again.";
      if (trpcErrorCode(failure) === "PRECONDITION_FAILED")
        setView({ kind: "confirm" });
      else {
        setView({ kind: "form" });
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  };

  const move = (index: number, by: -1 | 1) =>
    setFolders((current) => {
      const next = [...current];
      const [folder] = next.splice(index, 1);
      if (folder !== undefined) next.splice(index + by, 0, folder);
      return next;
    });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {view.kind === "choose"
              ? "Add a folder"
              : existing
                ? `Edit ${existing.title}`
                : "New library"}
          </DialogTitle>
          <DialogDescription className="text-pretty">
            {view.kind === "choose"
              ? "Choose a folder you can share. Everything in it and its subfolders is included."
              : "Paired devices see the files in these folders, read-only."}
          </DialogDescription>
        </DialogHeader>
        {view.kind === "choose" ? (
          <FolderChooser
            onCancel={() => setView({ kind: "form" })}
            onChoose={(path) => {
              setFolders((current) =>
                current.includes(path) ? current : [...current, path],
              );
              setView({ kind: "form" });
            }}
          />
        ) : view.kind === "confirm" ? (
          <div className="space-y-4">
            <div role="alert" className="space-y-2 text-pretty text-sm">
              <p>
                The new folders&apos; files are shared at once with the devices
                already paired with this library:
              </p>
              <ul className="list-disc space-y-1 pl-5">
                {existing?.devices.map((device) => (
                  <li key={device.id}>
                    <bdi>{device.name}</bdi>
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground">Nothing is saved yet.</p>
            </div>
            <DialogFooter>
              <Button
                variant="tertiary"
                disabled={busy}
                onClick={() => setView({ kind: "form" })}
              >
                Back
              </Button>
              <Button disabled={busy} onClick={() => void save(true)}>
                Share with these devices
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              void save(false);
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="library-title">Name</Label>
              <Input
                id="library-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="e.g. Kitchen"
                maxLength={120}
                required
                disabled={busy}
              />
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">Folders</p>
              {folders.length === 0 ? (
                <p className="text-sm text-muted-foreground">No folders yet.</p>
              ) : (
                <ol
                  aria-label="Library folders"
                  className="divide-y divide-border/50 rounded-xl border border-border/60"
                >
                  {folders.map((folder, index) => (
                    <li
                      key={folder}
                      className="flex items-center gap-2 px-3 py-2"
                    >
                      <Folder
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <span
                        className="min-w-0 flex-1 truncate text-sm"
                        title={folder}
                      >
                        {folder}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-compact"
                        aria-label={`Move ${folder} up`}
                        disabled={busy || index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowUp aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-compact"
                        aria-label={`Move ${folder} down`}
                        disabled={busy || index === folders.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowDown aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-compact"
                        aria-label={`Remove ${folder}`}
                        disabled={busy}
                        onClick={() =>
                          setFolders((current) =>
                            current.filter((entry) => entry !== folder),
                          )
                        }
                      >
                        <X aria-hidden="true" />
                      </Button>
                    </li>
                  ))}
                </ol>
              )}
              <Button
                type="button"
                variant="tertiary"
                size="compact"
                disabled={busy}
                onClick={() => setView({ kind: "choose" })}
              >
                Add folder
              </Button>
            </div>
            {error && (
              <p role="alert" className="text-pretty text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="tertiary"
                disabled={busy}
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={busy || folders.length === 0 || !title.trim()}
              >
                {busy ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
