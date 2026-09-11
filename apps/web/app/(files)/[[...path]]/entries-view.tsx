"use client";

import { FileText, Folder } from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { EntryMenu } from "./entry-menu";
import { EditEntryDialog, type EntryDialog } from "./entry-dialogs";
import { PreviewDialog } from "./preview-dialog";
import { SharingDialog } from "./sharing-dialog";
import { fileHref, type FileEntry } from "./types";
import type { useFileActions } from "./use-file-actions";
import { useFileDrag } from "./use-file-drag";

type Props = {
  view: "list" | "grid";
  groupByType: boolean;
  folders: FileEntry[];
  files: FileEntry[];
  sortedEntries: FileEntry[];
  actions: ReturnType<typeof useFileActions>;
};

export function EntriesView({
  view,
  groupByType,
  folders,
  files,
  sortedEntries,
  actions,
}: Props) {
  const drag = useFileDrag(actions.moveEntry);
  const [selection, setSelection] = useState<EntryDialog | null>(null);
  const select = (dialog: EntryDialog) => {
    setSelection(dialog);
    if (dialog.action === "preview")
      void actions.recordVisit(dialog.entry.path);
  };
  const groups = groupByType
    ? [
        { title: "Folders", entries: folders },
        { title: "Files", entries: files },
      ]
    : [{ title: "", entries: sortedEntries }];
  return (
    <>
      {drag.state.status === "error" && (
        <p role="alert" className="text-pretty text-sm text-destructive">{drag.state.message}</p>
      )}
      {drag.state.status === "moving" && (
        <p role="status" className="sr-only">Moving {drag.state.source.name}…</p>
      )}
      {groups
        .filter((group) => group.entries.length > 0)
        .map((group) => (
          <section key={group.title} className="space-y-3">
            {group.title && (
              <h2 className="px-3 text-balance text-xs font-medium text-muted-foreground">
                {group.title}
              </h2>
            )}
            <div
              className={cn(
                view === "grid"
                  ? "grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
                  : "space-y-1",
              )}
            >
              {group.entries.map((entry) => {
                const Icon = entry.type === "dir" ? Folder : FileText;
                const content = (
                  <>
                    {view === "grid" &&
                    entry.type === "file" &&
                    /\.(png|jpe?g|webp|gif|avif)$/i.test(entry.name) ? (
                      <Image
                        draggable={false}
                        unoptimized
                        src={`/api/files/thumbnail?path=${encodeURIComponent(entry.path)}`}
                        width={128}
                        height={80}
                        alt=""
                        className="h-20 w-full object-contain"
                      />
                    ) : (
                      <Icon
                        className={cn(
                          "shrink-0 text-muted-foreground",
                          entry.type === "dir" ? "fill-muted" : "",
                          view === "list" ? "size-5" : "size-12",
                        )}
                      />
                    )}
                    <span
                      className={cn(
                        "min-w-0 truncate text-sm",
                        view === "grid" && "w-full text-center",
                      )}
                    >
                      {entry.name}
                    </span>
                  </>
                );
                const className = cn(
                  "w-full rounded-lg text-left hover:bg-accent/70 focus-visible:outline-2 focus-visible:outline-ring",
                  view === "list"
                    ? "flex min-h-12 items-center gap-3 py-3 pl-3 pr-12"
                    : "flex min-h-36 flex-col items-center justify-center gap-3 border bg-muted/30 px-4 pb-4 pt-10",
                  drag.isDragging(entry) && "opacity-50",
                  drag.isDropTarget(entry) && "bg-accent ring-2 ring-inset ring-primary",
                );
                return (
                  <EntryMenu
                    key={entry.path}
                    entry={entry}
                    actions={actions}
                    onSelect={select}
                  >
                    {entry.type === "dir" ? (
                      <Link
                        {...drag.getDragProps(entry)}
                        href={fileHref(entry.path)}
                        className={className}
                        data-entry-name={entry.name}
                        data-entry-path={entry.path}
                        onMouseEnter={() => actions.prefetchFolder(entry)}
                        onFocus={() => actions.prefetchFolder(entry)}
                      >
                        {content}
                      </Link>
                    ) : (
                      <button
                        {...drag.getDragProps(entry)}
                        className={className}
                        data-entry-name={entry.name}
                        data-entry-path={entry.path}
                        onClick={() => select({ action: "preview", entry })}
                      >
                        {content}
                      </button>
                    )}
                  </EntryMenu>
                );
              })}
            </div>
          </section>
        ))}
      {selection?.action === "preview" ? (
        <PreviewDialog
          entry={selection.entry}
          onClose={() => setSelection(null)}
        />
      ) : selection?.action === "share" ? (
        <SharingDialog
          entry={selection.entry}
          onClose={() => setSelection(null)}
        />
      ) : (
        selection && (
          <EditEntryDialog
            key={`${selection.action}:${selection.entry.path}`}
            selection={selection}
            actions={actions}
            onClose={() => setSelection(null)}
          />
        )
      )}
    </>
  );
}
