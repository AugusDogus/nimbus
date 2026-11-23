import { MoveUp } from "./move-up";
import {
  Copy,
  CornerLeftUp,
  Download,
  FolderInput,
  ListChecks,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { createContext, useContext, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { EntryDialog } from "./entry-dialogs";
import { selectionCapabilities } from "./entry-menu";
import type { OtherPane } from "./split-layout";
import { starControl, useStarredPaths } from "./starred";
import type { FileEntry } from "./types";
import type { useFileActions } from "./use-file-actions";

function Action({
  label,
  icon,
  onClick,
  destructive,
  disabled,
  className,
  iconOnly = false,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
  className?: string;
  /** Keeps the label for screen readers and the tooltip only, where the bar has no room for it. */
  iconOnly?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={disabled}
      title={iconOnly ? label : undefined}
      onClick={onClick}
      className={cn(
        "touch-hit gap-2 pointer-coarse:min-w-11",
        destructive && "text-destructive hover:text-destructive",
        className,
      )}
    >
      {icon}
      {/* Labels show from 1024 px, where the bar has room for them beside the sidebar. */}
      <span className={iconOnly ? "sr-only" : "sr-only lg:not-sr-only"}>
        {label}
      </span>
    </Button>
  );
}

/** What the other pane's actions in the selection bar are given. */
export type OtherPaneActionsProps = {
  targets: readonly FileEntry[];
  other: OtherPane;
  canMove: boolean;
  /** In a pane of a split view: names the folder beside the icons once the pane is wide enough. */
  labelled: boolean;
  actions: ReturnType<typeof useFileActions>;
};

/**
 * Renders the actions that move or copy the selection straight into the other pane's folder.
 * The split view gives it, so their code loads with the split view rather than every folder.
 */
export const OtherPaneActionsSlot = createContext<
  ((props: OtherPaneActionsProps) => ReactNode) | null
>(null);

/**
 * Actions for the selected entries. It overlays the folder toolbar, or floats above the content
 * when there is no toolbar, so showing it never moves the entries.
 */
export function SelectionBar({
  targets,
  total,
  floating,
  actions,
  moveUp,
  onOpen,
  onSelectAll,
  onClear,
  other = null,
  compact = false,
}: {
  targets: readonly FileEntry[];
  total: number;
  floating: boolean;
  actions: ReturnType<typeof useFileActions>;
  /** Whether the selection may move up into the folder above the one shown (see `MoveUp`). */
  moveUp: MoveUp;
  onOpen: (dialog: EntryDialog) => void;
  onSelectAll: () => void;
  onClear: () => void;
  /** The other pane's folder in a split view, which the selection can go to directly. */
  other?: OtherPane | null;
  /** In a pane of a split view: the usual actions show only icons, leaving room for the other pane's. */
  compact?: boolean;
}) {
  const { move: canMove, trash: canTrash } = selectionCapabilities(targets);
  // The bar keeps its buttons in place while it shows, as a menu does (see `MoveUp.steady`).
  const [moveUpAtOpen] = useState(moveUp);
  const up = MoveUp.steady(moveUpAtOpen, moveUp);
  const star = starControl(targets, useStarredPaths(true), actions.setStarred);
  const otherPaneActions = useContext(OtherPaneActionsSlot);
  return (
    <div
      role="toolbar"
      aria-label="Selected items"
      data-toast-clearance={floating ? "always" : undefined}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClear();
      }}
      className={cn(
        "z-20 flex items-center gap-1 bg-background",
        floating
          ? "fixed bottom-[calc(max(1.5rem,env(safe-area-inset-bottom))+var(--impersonation-offset,0px))] left-1/2 -translate-x-1/2 rounded-full border px-2 py-1.5 shadow-lg"
          : "absolute inset-0 px-2 md:px-4 lg:px-6",
      )}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Clear selection"
        onClick={onClear}
        className="touch-hit pointer-coarse:w-11"
      >
        <X className="size-4" />
      </Button>
      <p
        aria-live="polite"
        className="min-w-0 truncate px-1 text-sm font-medium tabular-nums"
      >
        {targets.length.toLocaleString()}
        {/* Narrow touch screens keep the 44 px buttons in a row by showing only the count. */}
        <span className="max-md:pointer-coarse:sr-only"> selected</span>
      </p>
      <div className="ml-auto flex min-w-0 items-center gap-0.5">
        {other &&
          otherPaneActions?.({
            targets,
            other,
            canMove,
            labelled: compact,
            actions,
          })}
        {targets.length < total && (
          <Action
            label="Select all"
            iconOnly={compact}
            // Phones with a second folder to offer keep Select all in the item menus.
            className={other ? "max-md:hidden" : undefined}
            icon={<ListChecks className="size-4" />}
            onClick={onSelectAll}
          />
        )}
        <Action
          label="Download"
          iconOnly={compact}
          icon={<Download className="size-4" />}
          onClick={() => actions.downloadEntries(targets)}
        />
        <Action
          label={star.label}
          iconOnly={compact}
          className={other ? "max-md:hidden" : undefined}
          icon={<Star className="size-4" />}
          disabled={star.disabled}
          onClick={star.run}
        />
        <Action
          label="Copy"
          iconOnly={compact || other !== null}
          icon={<Copy className="size-4" />}
          onClick={() => onOpen({ action: "copy", entries: targets })}
        />
        {canMove && (
          <Action
            label="Move"
            iconOnly={compact || other !== null}
            icon={<FolderInput className="size-4" />}
            onClick={() => onOpen({ action: "move", entries: targets })}
          />
        )}
        {canMove && up.kind !== "none" && (
          <Action
            // Phones have no room for it beside the other 44 px actions; item menus offer it there.
            className="max-md:hidden"
            iconOnly
            label="Move up one level"
            icon={<CornerLeftUp className="size-4" />}
            disabled={up.kind !== "into"}
            onClick={() => {
              if (up.kind === "into")
                void actions.moveEntries(targets, up.path);
            }}
          />
        )}
        {canTrash && (
          <Action
            label="Trash"
            iconOnly={compact}
            destructive
            icon={<Trash2 className="size-4" />}
            onClick={() => onOpen({ action: "delete", entries: targets })}
          />
        )}
      </div>
    </div>
  );
}
