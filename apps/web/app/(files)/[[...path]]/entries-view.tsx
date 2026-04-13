"use client";

import { Download, EllipsisVertical, FileText, Folder, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";

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
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Drawer,
    DrawerClose,
    DrawerContent,
    DrawerDescription,
    DrawerHeader,
    DrawerTitle,
} from "@/components/ui/drawer";
import { DrawerActionItem } from "@/components/drawer-action-item";
import { Input } from "@/components/ui/input";
import { useDialogInputSelect } from "@/hooks/use-dialog-input-select";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

import type { FileEntry } from "./types";

type FileActions = {
  downloadFile: (path: string) => void;
  renameEntry: (path: string, newName: string) => Promise<void>;
  deleteEntry: (path: string) => Promise<void>;
  prefetchFolder: (entry: FileEntry) => void;
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
  if (!entry) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <RenameForm key={entry.path} entry={entry} onOpenChange={onOpenChange} onRename={onRename} />
    </Dialog>
  );
}

function RenameForm({
  entry,
  onOpenChange,
  onRename,
}: {
  entry: FileEntry;
  onOpenChange: (open: boolean) => void;
  onRename: (path: string, newName: string) => Promise<void>;
}) {
  const [name, setName] = useState(entry.name);
  const [submitting, setSubmitting] = useState(false);

  const getSelectionRange = useCallback(
    (value: string): [number, number] | null => {
      if (entry.type === "file") {
        const dotIdx = value.lastIndexOf(".");
        if (dotIdx > 0) return [0, dotIdx];
      }
      return null;
    },
    [entry],
  );

  const { inputRef, handleOpenAutoFocus } = useDialogInputSelect(getSelectionRange);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || name.trim() === entry.name) {
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
    <DialogContent onOpenAutoFocus={handleOpenAutoFocus}>
      <form onSubmit={handleSubmit}>
        <DialogHeader>
          <DialogTitle>Rename</DialogTitle>
          <DialogDescription>
            Enter a new name for &ldquo;{entry.name}&rdquo;
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

// ─── Mobile File Action Drawer ──────────────────────────────────────────────

function FileActionDrawer({
  entry,
  open,
  onOpenChange,
  onStartRename,
  onStartDelete,
  onDownload,
}: {
  entry: FileEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStartRename: (entry: FileEntry) => void;
  onStartDelete: (entry: FileEntry) => void;
  onDownload: (path: string) => void;
}) {
  if (!entry) return null;
  const isDir = entry.type === "dir";

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle className="truncate">{entry.name}</DrawerTitle>
          <DrawerDescription className="sr-only">
            Actions for {entry.name}
          </DrawerDescription>
        </DrawerHeader>
        <div className="flex flex-col gap-1 px-4 pb-6">
          {!isDir && (
            <DrawerClose asChild>
              <DrawerActionItem onClick={() => onDownload(entry.path)}>
                <Download className="size-5 text-muted-foreground" />
                Download
              </DrawerActionItem>
            </DrawerClose>
          )}
          <DrawerClose asChild>
            <DrawerActionItem onClick={() => onStartRename(entry)}>
              <Pencil className="size-5 text-muted-foreground" />
              Rename
            </DrawerActionItem>
          </DrawerClose>
          <DrawerClose asChild>
            <DrawerActionItem
              className="text-destructive hover:bg-destructive/10 active:bg-destructive/10"
              onClick={() => onStartDelete(entry)}
            >
              <Trash2 className="size-5" />
              Delete
            </DrawerActionItem>
          </DrawerClose>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

// ─── More Button (opens Drawer on mobile, dropdown on desktop) ───────────────

function MoreButton({
  entry,
  view,
  isMobile,
  onDownload,
  onDesktopMenuOpenChange,
  onOpenDrawer,
  onStartDelete,
  onStartRename,
}: {
  entry: FileEntry;
  view: "list" | "grid";
  isMobile: boolean;
  onDownload: (path: string) => void;
  onDesktopMenuOpenChange?: (open: boolean) => void;
  onOpenDrawer: (entry: FileEntry) => void;
  onStartDelete: (entry: FileEntry) => void;
  onStartRename: (entry: FileEntry) => void;
}) {
  const isDir = entry.type === "dir";

  const trigger = (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn(
        "shrink-0",
        view === "list"
          ? "md:opacity-0 md:group-hover/entry:opacity-100 md:group-focus-within/entry:opacity-100"
          : "absolute right-1 top-1 md:opacity-0 md:group-hover/entry:opacity-100 md:group-focus-within/entry:opacity-100",
      )}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (isMobile) {
          onOpenDrawer(entry);
        }
      }}
      onContextMenu={(e) => {
        if (!isMobile) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      aria-label={`Actions for ${entry.name}`}
    >
      <EllipsisVertical className="size-4" />
    </Button>
  );

  if (isMobile) {
    return trigger;
  }

  return (
    <DropdownMenu onOpenChange={onDesktopMenuOpenChange}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {!isDir && (
          <>
            <DropdownMenuItem onClick={() => onDownload(entry.path)}>
              <Download />
              Download
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onClick={() => onStartRename(entry)}>
          <Pencil />
          Rename
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => onStartDelete(entry)}>
          <Trash2 />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── Entry Item with Context Menu (desktop) / Drawer (mobile) ───────────────

function EntryItem({
  entry,
  view,
  isMobile,
  onStartRename,
  onStartDelete,
  onDownload,
  onPrefetch,
  onOpenDrawer,
}: {
  entry: FileEntry;
  view: "list" | "grid";
  isMobile: boolean;
  onStartRename: (entry: FileEntry) => void;
  onStartDelete: (entry: FileEntry) => void;
  onDownload: (path: string) => void;
  onPrefetch?: (entry: FileEntry) => void;
  onOpenDrawer: (entry: FileEntry) => void;
}) {
  const isDir = entry.type === "dir";
  const [contextMenuOpen, setContextMenuOpen] = useState(false);

  const moreButton = (
    <MoreButton
      entry={entry}
      view={view}
      isMobile={isMobile}
      onDownload={onDownload}
      onDesktopMenuOpenChange={(open) => {
        if (open) {
          setContextMenuOpen(false);
        }
      }}
      onOpenDrawer={onOpenDrawer}
      onStartDelete={onStartDelete}
      onStartRename={onStartRename}
    />
  );

  const content = isDir ? (
    view === "list" ? (
      <Link
        href={`/${entry.path}`}
        onMouseEnter={() => onPrefetch?.(entry)}
        onFocus={() => onPrefetch?.(entry)}
        data-entry-name={entry.name}
        data-entry-path={entry.path}
        className="group/entry flex min-h-12 items-center gap-4 rounded-lg px-4 py-3 hover:bg-accent"
      >
        <Folder className="size-6 shrink-0 fill-muted text-muted-foreground" />
        <span className="flex-1 truncate text-sm font-medium">{entry.name}</span>
        {moreButton}
      </Link>
    ) : (
      <div className="group/entry relative">
        <Link
          href={`/${entry.path}`}
          onMouseEnter={() => onPrefetch?.(entry)}
          onFocus={() => onPrefetch?.(entry)}
          data-entry-name={entry.name}
          data-entry-path={entry.path}
          className="flex flex-col items-center justify-center gap-2 rounded-xl border bg-muted/50 p-3 hover:border-border hover:bg-accent sm:gap-3 sm:p-4"
        >
          <Folder className="size-10 fill-muted text-muted-foreground sm:size-12" />
          <span className="w-full truncate text-center text-xs font-medium sm:text-sm">
            {entry.name}
          </span>
        </Link>
        {moreButton}
      </div>
    )
  ) : view === "list" ? (
    <div
      data-entry-name={entry.name}
      data-entry-path={entry.path}
      className="group/entry flex min-h-12 cursor-default items-center gap-4 rounded-lg px-4 py-3 hover:bg-accent"
    >
      <FileText className="size-6 shrink-0 text-primary" />
      <span className="flex-1 truncate text-sm">{entry.name}</span>
      {moreButton}
    </div>
  ) : (
    <div
      data-entry-name={entry.name}
      data-entry-path={entry.path}
      className="group/entry relative flex cursor-default flex-col rounded-xl border bg-card hover:border-border hover:shadow-sm"
    >
      <div className="flex h-20 items-center justify-center rounded-t-xl bg-muted sm:h-28">
        <FileText className="size-8 text-primary sm:size-10" />
      </div>
      <div className="border-t p-2 sm:p-3">
        <span className="line-clamp-2 text-xs sm:text-sm">{entry.name}</span>
      </div>
      {moreButton}
    </div>
  );

  // On mobile, skip ContextMenu wrapper entirely -- use the Drawer via more button
  if (isMobile) {
    return content;
  }

  return (
    <ContextMenu open={contextMenuOpen} onOpenChange={setContextMenuOpen}>
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
  isMobile,
  onStartRename,
  onStartDelete,
  onDownload,
  onPrefetch,
  onOpenDrawer,
}: {
  entries: FileEntry[];
  view: "list" | "grid";
  isMobile: boolean;
  onStartRename: (entry: FileEntry) => void;
  onStartDelete: (entry: FileEntry) => void;
  onDownload: (path: string) => void;
  onPrefetch?: (entry: FileEntry) => void;
  onOpenDrawer: (entry: FileEntry) => void;
}) {
  return (
    <div className={gridClassName(view)}>
      {entries.map((entry) => (
        <EntryItem
          key={entry.path}
          entry={entry}
          view={view}
          isMobile={isMobile}
          onStartRename={onStartRename}
          onStartDelete={onStartDelete}
          onDownload={onDownload}
          onPrefetch={onPrefetch}
          onOpenDrawer={onOpenDrawer}
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
  const isMobile = useIsMobile();
  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [drawerTarget, setDrawerTarget] = useState<FileEntry | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const handleStartRename = useCallback((entry: FileEntry) => {
    setRenameTarget(entry);
    setRenameOpen(true);
  }, []);

  const handleStartDelete = useCallback((entry: FileEntry) => {
    setDeleteTarget(entry);
    setDeleteOpen(true);
  }, []);

  const handleOpenDrawer = useCallback((entry: FileEntry) => {
    setDrawerTarget(entry);
    setDrawerOpen(true);
  }, []);

  const sharedProps = {
    isMobile,
    onStartRename: handleStartRename,
    onStartDelete: handleStartDelete,
    onDownload: actions.downloadFile,
    onPrefetch: actions.prefetchFolder,
    onOpenDrawer: handleOpenDrawer,
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

      <FileActionDrawer
        entry={drawerTarget}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        onStartRename={handleStartRename}
        onStartDelete={handleStartDelete}
        onDownload={actions.downloadFile}
      />

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
