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
  type LucideIcon,
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
  icon: LucideIcon;
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
      size="compact"
      leadingIcon={icon}
      disabled={disabled}
      title={iconOnly ? label : undefined}
      onClick={onClick}
      className={cn(
        "touch-hit gap-2 pointer-coarse:min-w-11",
        destructive && "text-destructive hover:text-destructive",
        className,
      )}
    >
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
  /**
   * In a pane of a split view, the selection's less frequent actions, for a menu after the rest;
   * the other pane's actions then name its folder once the pane is wide enough. Null elsewhere.
   */
  more: readonly MenuAction[] | null;
  actions: ReturnType<typeof useFileActions>;
};

/** One action in a menu: what it says, and what it does. */
export type MenuAction = { label: string; run: () => void };

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
  /**
   * In a pane of a split view: the other pane's actions keep their labels, Download and Trash
   * show as icons, and the rest go into a menu.
   */
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
        "z-20 flex items-center gap-1",
        floating
          ? "fixed bottom-[calc(max(1.5rem,env(safe-area-inset-bottom))+var(--impersonation-offset,0px))] left-1/2 -translate-x-1/2 rounded-full border bg-background px-2 py-1.5 shadow-lg"
          : compact
            ? // Takes the colour of the pane header it covers.
              "absolute inset-0 bg-inherit px-2"
            : // From 768 px it covers the folder card's header and takes its colour.
              "absolute inset-0 bg-background px-2 md:bg-inherit",
      )}
    >
      <Button
        variant="ghost"
        size="icon-compact"
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
            more: compact
              ? [
                  ...(targets.length < total
                    ? [{ label: "Select all", run: onSelectAll }]
                    : []),
                  {
                    label: "Copy to…",
                    run: () => onOpen({ action: "copy", entries: targets }),
                  },
                  ...(canMove
                    ? [
                        {
                          label: "Move to…",
                          run: () =>
                            onOpen({ action: "move", entries: targets }),
                        },
                      ]
                    : []),
                  ...(star.disabled
                    ? []
                    : [{ label: star.label, run: star.run }]),
                  ...(canMove && up.kind === "into"
                    ? [
                        {
                          label: "Move up one level",
                          run: () => void actions.moveEntries(targets, up.path),
                        },
                      ]
                    : []),
                ]
              : null,
            actions,
          })}
        {!compact && targets.length < total && (
          <Action
            label="Select all"
            iconOnly={compact}
            icon={ListChecks}
            onClick={onSelectAll}
          />
        )}
        <Action
          label="Download"
          iconOnly={compact}
          icon={Download}
          onClick={() => actions.downloadEntries(targets)}
        />
        {!compact && (
          <Action
            label={star.label}
            iconOnly={compact}
            icon={Star}
            disabled={star.disabled}
            onClick={star.run}
          />
        )}
        {!compact && (
          <Action
            label="Copy"
            iconOnly={compact || other !== null}
            icon={Copy}
            onClick={() => onOpen({ action: "copy", entries: targets })}
          />
        )}
        {!compact && canMove && (
          <Action
            label="Move"
            iconOnly={compact || other !== null}
            icon={FolderInput}
            onClick={() => onOpen({ action: "move", entries: targets })}
          />
        )}
        {!compact && canMove && up.kind !== "none" && (
          <Action
            // Phones have no room for it beside the other 44 px actions; item menus offer it there.
            className="max-md:hidden"
            iconOnly
            label="Move up one level"
            icon={CornerLeftUp}
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
            icon={Trash2}
            onClick={() => onOpen({ action: "delete", entries: targets })}
          />
        )}
      </div>
    </div>
  );
}
