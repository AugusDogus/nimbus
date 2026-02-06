"use client";

import { Download, FileText, Folder, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useRef, useState } from "react";

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
import { Button } from "@/components/ui/button";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import type { FileEntry } from "./types";

type FileActions = {
  downloadFile: (path: string) => void;
  renameEntry: (path: string, newName: string) => Promise<void>;
  deleteEntry: (path: string) => Promise<void>;
};

type EntriesViewProps = {
  view: "list" | "grid";
  groupByType: boolean;
  folders: FileEntry[];
  files: FileEntry[];
  sortedEntries: FileEntry[];
  actions: FileActions;
};

// ─── Rename Dialog ──────────────────────────────────────────────────────────

function RenameDialog({
  entry,
  open,
  onOpenChange,
  onRename,
}: {
  entry: FileEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRename: (path: string, newName: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleOpen = useCallback(
    (isOpen: boolean) => {
      if (isOpen && entry) {
        setName(entry.name);
        // Select filename without extension for files
        requestAnimationFrame(() => {
          const input = inputRef.current;
          if (!input) return;
          input.focus();
          if (entry.type === "file") {
            const dotIdx = entry.name.lastIndexOf(".");
            if (dotIdx > 0) {
              input.setSelectionRange(0, dotIdx);
              return;
            }
          }
          input.select();
        });
      }
      onOpenChange(isOpen);
    },
    [entry, onOpenChange],
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!entry || !name.trim() || name.trim() === entry.name) {
      onOpenChange(false);
      return;
    }
    setSubmitting(true);
    try {
      await onRename(entry.path, name.trim());
      onOpenChange(false);
    } catch {
      // error toast is handled by the hook
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Rename</DialogTitle>
            <DialogDescription>
              Enter a new name for &ldquo;{entry?.name}&rdquo;
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
              data-1p-ignore
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !name.trim()}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Delete Confirmation ────────────────────────────────────────────────────

function DeleteDialog({
  entry,
  open,
  onOpenChange,
  onDelete,
}: {
  entry: FileEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: (path: string) => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!entry) return;
    setDeleting(true);
    try {
      await onDelete(entry.path);
      onOpenChange(false);
    } catch {
      // error toast handled by the hook
    } finally {
      setDeleting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {entry?.type === "dir" ? "folder" : "file"}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to permanently delete &ldquo;{entry?.name}&rdquo;?
            {entry?.type === "dir" && " This will delete all contents inside the folder."}
            {" "}This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={handleDelete} disabled={deleting}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ─── Entry Item with Context Menu ───────────────────────────────────────────

function EntryItem({
  entry,
  view,
  onStartRename,
  onStartDelete,
  onDownload,
}: {
  entry: FileEntry;
  view: "list" | "grid";
  onStartRename: (entry: FileEntry) => void;
  onStartDelete: (entry: FileEntry) => void;
  onDownload: (path: string) => void;
}) {
  const isDir = entry.type === "dir";

  const content = isDir ? (
    view === "list" ? (
      <Link
        href={`/files/${entry.path}`}
        className="flex items-center gap-4 rounded-lg px-4 py-3 hover:bg-accent"
      >
        <Folder className="size-6 fill-muted text-muted-foreground" />
        <span className="flex-1 truncate text-sm font-medium">{entry.name}</span>
      </Link>
    ) : (
      <Link
        href={`/files/${entry.path}`}
        className="flex flex-col items-center justify-center gap-2 rounded-xl border bg-muted/50 p-3 hover:border-border hover:bg-accent sm:gap-3 sm:p-4"
      >
        <Folder className="size-10 fill-muted text-muted-foreground sm:size-12" />
        <span className="w-full truncate text-center text-xs font-medium sm:text-sm">
          {entry.name}
        </span>
      </Link>
    )
  ) : view === "list" ? (
    <div className="flex cursor-default items-center gap-4 rounded-lg px-4 py-3 hover:bg-accent">
      <FileText className="size-6 text-primary" />
      <span className="flex-1 truncate text-sm">{entry.name}</span>
    </div>
  ) : (
    <div className="flex cursor-default flex-col rounded-xl border bg-card hover:border-border hover:shadow-sm">
      <div className="flex h-20 items-center justify-center rounded-t-xl bg-muted sm:h-28">
        <FileText className="size-8 text-primary sm:size-10" />
      </div>
      <div className="border-t p-2 sm:p-3">
        <span className="line-clamp-2 text-xs sm:text-sm">{entry.name}</span>
      </div>
    </div>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{content}</ContextMenuTrigger>
      <ContextMenuContent>
        {!isDir && (
          <>
            <ContextMenuItem onClick={() => onDownload(entry.path)}>
              <Download />
              Download
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem onClick={() => onStartRename(entry)}>
          <Pencil />
          Rename
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => onStartDelete(entry)}>
          <Trash2 />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ─── Grid / List layout ─────────────────────────────────────────────────────

const gridClassName = (view: "list" | "grid") =>
  cn(
    view === "list"
      ? "space-y-1"
      : "grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6",
  );

function EntriesGrid({
  entries,
  view,
  onStartRename,
  onStartDelete,
  onDownload,
}: {
  entries: FileEntry[];
  view: "list" | "grid";
  onStartRename: (entry: FileEntry) => void;
  onStartDelete: (entry: FileEntry) => void;
  onDownload: (path: string) => void;
}) {
  return (
    <div className={gridClassName(view)}>
      {entries.map((entry) => (
        <EntryItem
          key={entry.path}
          entry={entry}
          view={view}
          onStartRename={onStartRename}
          onStartDelete={onStartDelete}
          onDownload={onDownload}
        />
      ))}
    </div>
  );
}

// ─── Main export ────────────────────────────────────────────────────────────

export function EntriesView({
  view,
  groupByType,
  folders,
  files,
  sortedEntries,
  actions,
}: EntriesViewProps) {
  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const handleStartRename = useCallback((entry: FileEntry) => {
    setRenameTarget(entry);
    setRenameOpen(true);
  }, []);

  const handleStartDelete = useCallback((entry: FileEntry) => {
    setDeleteTarget(entry);
    setDeleteOpen(true);
  }, []);

  const sharedProps = {
    onStartRename: handleStartRename,
    onStartDelete: handleStartDelete,
    onDownload: actions.downloadFile,
  };

  return (
    <>
      {groupByType ? (
        <>
          {folders.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-medium text-muted-foreground">
                Folders
              </h2>
              <EntriesGrid entries={folders} view={view} {...sharedProps} />
            </section>
          )}

          {files.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-medium text-muted-foreground">
                Files
              </h2>
              <EntriesGrid entries={files} view={view} {...sharedProps} />
            </section>
          )}
        </>
      ) : (
        <EntriesGrid entries={sortedEntries} view={view} {...sharedProps} />
      )}

      <RenameDialog
        entry={renameTarget}
        open={renameOpen}
        onOpenChange={setRenameOpen}
        onRename={actions.renameEntry}
      />
      <DeleteDialog
        entry={deleteTarget}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDelete={actions.deleteEntry}
      />
    </>
  );
}
