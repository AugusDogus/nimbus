"use client";

import {
  Copy,
  Download,
  FolderInput,
  ListChecks,
  Star,
  Trash2,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { EntryDialog } from "./entry-dialogs";
import { selectionCapabilities } from "./entry-menu";
import type { FileEntry } from "./types";
import type { useFileActions } from "./use-file-actions";

function Action({
  label,
  icon,
  onClick,
  destructive,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      className={cn(
        "gap-2",
        destructive && "text-destructive hover:text-destructive",
      )}
    >
      {icon}
      <span className="sr-only md:not-sr-only">{label}</span>
    </Button>
  );
}

/**
 * Actions for the selected entries. It overlays the folder toolbar, or floats above the content
 * when there is no toolbar, so showing it never moves the entries.
 */
export function SelectionBar({
  targets,
  total,
  floating,
  actions,
  onOpen,
  onSelectAll,
  onClear,
}: {
  targets: readonly FileEntry[];
  total: number;
  floating: boolean;
  actions: ReturnType<typeof useFileActions>;
  onOpen: (dialog: EntryDialog) => void;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  const { move: canMove, trash: canTrash } = selectionCapabilities(targets);
  return (
    <div
      role="toolbar"
      aria-label="Selected items"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClear();
      }}
      className={cn(
        "z-20 flex items-center gap-1 bg-background",
        floating
          ? "fixed bottom-[max(1.5rem,env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 rounded-full border px-2 py-1.5 shadow-lg"
          : "absolute inset-0 px-2 md:px-4 lg:px-6",
      )}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Clear selection"
        onClick={onClear}
      >
        <X className="size-4" />
      </Button>
      <p
        aria-live="polite"
        className="min-w-0 truncate px-1 text-sm font-medium tabular-nums"
      >
        {targets.length.toLocaleString()} selected
      </p>
      <div className="ml-auto flex items-center gap-0.5">
        {targets.length < total && (
          <Action
            label="Select all"
            icon={<ListChecks className="size-4" />}
            onClick={onSelectAll}
          />
        )}
        <Action
          label="Download"
          icon={<Download className="size-4" />}
          onClick={() => actions.downloadEntries(targets)}
        />
        <Action
          label="Star"
          icon={<Star className="size-4" />}
          onClick={() => void actions.starEntries(targets)}
        />
        <Action
          label="Copy"
          icon={<Copy className="size-4" />}
          onClick={() => onOpen({ action: "copy", entries: targets })}
        />
        {canMove && (
          <Action
            label="Move"
            icon={<FolderInput className="size-4" />}
            onClick={() => onOpen({ action: "move", entries: targets })}
          />
        )}
        {canTrash && (
          <Action
            label="Trash"
            destructive
            icon={<Trash2 className="size-4" />}
            onClick={() => onOpen({ action: "delete", entries: targets })}
          />
        )}
      </div>
    </div>
  );
}
