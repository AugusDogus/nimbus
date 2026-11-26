import { SlidersHorizontal, X } from "lucide-react";
import {
  DropdownContent,
  DropdownLabel,
  DropdownMenu,
  DropdownSeparator,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import { MenuItem } from "@/components/ui/menu-item";
import { SortOption } from "../sort-option";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DriveRoot } from "@nimbus/api/drive-root";
import type { PaneFailure, PanePrefs } from "../files-page-client";
import type { FolderCardClasses, FolderMoves } from "../folder-card";
import type { PaneSide } from "../split-layout";
import type { SplitMode } from "../split-frame";

const sideName = { left: "Left", right: "Right" } as const;

/** Where a pane can go: back to the folder it showed before, up a level, or its top folder. */
export type PaneMoves = FolderMoves & { top: () => void };

/** Why a pane's folder cannot be shown, with ways on that keep the pane open. */
export function PaneFailureView({
  failure,
  moves,
}: {
  failure: PaneFailure;
  moves: PaneMoves;
}) {
  const text =
    failure.code === "NOT_FOUND"
      ? {
          title: "Folder not found",
          body: "It may have moved or been deleted. The other pane is unchanged.",
        }
      : failure.code === "FORBIDDEN"
        ? {
            title: "You do not have access to this folder",
            body: "Ask a server administrator, or the person who shared it with you, for access.",
          }
        : {
            title: "Could not open this folder",
            body: "The server may be unavailable. Your files have not been changed.",
          };
  return (
    <div role="alert" className="space-y-4 rounded-lg border p-6">
      <h2 className="text-balance text-lg font-semibold">{text.title}</h2>
      <p className="text-pretty text-sm text-muted-foreground">{text.body}</p>
      <div className="flex flex-wrap gap-3">
        {failure.code === null && (
          <Button onClick={failure.retry}>Try again</Button>
        )}
        {moves.up && (
          <Button
            variant={failure.code === null ? "tertiary" : "primary"}
            onClick={moves.up}
          >
            Open parent
          </Button>
        )}
        <Button variant="tertiary" onClick={moves.top}>
          Open {DriveRoot.label}
        </Button>
      </div>
    </div>
  );
}

/** The inactive pane's surface: the page's tint mixed into the window's, flatter than a card. */
const recessed =
  "bg-[color-mix(in_oklab,var(--background)_45%,var(--sidebar))]";

/** The pane's sort, grouping and view, and folding the pane away, in one menu. */
function PaneViewMenu({
  prefs: { prefs, updatePreferences },
  onCollapse,
}: {
  prefs: PanePrefs;
  onCollapse: (() => void) | null;
}) {
  const sort = SortOption.value({
    field: prefs.sortField,
    direction: prefs.sortDirection,
  });
  // Rows are numbered in order: the sort options first, then these. Their menu merges the checked
  // backgrounds of rows numbered one after the other, so a number is skipped between groups.
  const sorts = SortOption.all.length;
  const rows = {
    group: sorts + 1,
    list: sorts + 3,
    grid: sorts + 4,
    collapse: sorts + 6,
  };
  const checked = [
    SortOption.all.findIndex((option) => SortOption.value(option) === sort),
    ...(prefs.groupByType ? [rows.group] : []),
    prefs.view === "list" ? rows.list : rows.grid,
  ];
  return (
    // Compact rows keep all thirteen in view, under the menu's height limit.
    <DropdownMenu size="compact">
      <DropdownTrigger
        render={
          <Button
            variant="ghost"
            size="icon-compact"
            aria-label="Pane options"
            title="Sort, view and collapse"
            className={cn(
              "touch-hit shrink-0",
              // Quieter on the inactive pane, as its card marks it (`data-active`): a switch
              // restyles it without rendering the menu again.
              "text-muted-foreground group-data-active/pane:text-foreground",
            )}
          />
        }
      >
        <SlidersHorizontal className="size-4" />
      </DropdownTrigger>
      {/* Every checked row is listed, so each choice is a checkbox row that keeps the menu open;
          their menu holds one radio group, and this one has two kinds of choice. */}
      <DropdownContent align="end" className="w-52" checkedIndices={checked}>
        <DropdownLabel>Sort by</DropdownLabel>
        {SortOption.all.map((option, index) => (
          <MenuItem
            key={SortOption.value(option)}
            index={index}
            label={option.label}
            checked={SortOption.value(option) === sort}
            onSelect={() =>
              updatePreferences({
                sortField: option.field,
                sortDirection: option.direction,
              })
            }
          />
        ))}
        <DropdownSeparator />
        <MenuItem
          index={rows.group}
          label="Group by type"
          checked={prefs.groupByType}
          onSelect={() =>
            updatePreferences({ groupByType: !prefs.groupByType })
          }
        />
        <DropdownSeparator />
        <DropdownLabel>View</DropdownLabel>
        <MenuItem
          index={rows.list}
          label="List"
          checked={prefs.view === "list"}
          onSelect={() => updatePreferences({ view: "list" })}
        />
        <MenuItem
          index={rows.grid}
          label="Grid"
          checked={prefs.view === "grid"}
          onSelect={() => updatePreferences({ view: "grid" })}
        />
        {onCollapse && (
          <>
            <DropdownSeparator />
            <MenuItem
              index={rows.collapse}
              label="Collapse pane"
              closeOnClick
              onSelect={onCollapse}
            />
          </>
        )}
      </DropdownContent>
    </DropdownMenu>
  );
}

/** The active pane's card: raised as a page's one card is from 768 px (`PageSurface`). */
const raised =
  "rounded-xl bg-card ring-1 ring-border/80 shadow-raised dark:ring-white/[0.08]";

/**
 * A pane's card. Side by side, the active one is raised and white, the other flatter, tinted and
 * quieter; a drop target is washed and ringed inside, unlike the active pane, which only rises.
 * One at a time, on a phone, each pane is a folder's card as it is alone, whichever is active: the
 * one in view is the one in use, the other sits a step back (`PaneDepth`), and its path needs the
 * header's room, so Back and Up are left to the browser and the path, as alone.
 */
export function paneCard(
  side: PaneSide,
  active: boolean,
  highlighted: boolean,
  mode: SplitMode,
): { label: string; classes: FolderCardClasses } {
  const label = `${sideName[side]} pane${active ? " (active)" : ""}`;
  if (mode === "swipe")
    return {
      label,
      classes: {
        // Contained: what changes in one card never lays out or paints the other.
        // Its own layer, as it is scaled with the frame's scroll (`useSwipePanes`), so a swipe
        // moves pixels already drawn rather than drawing the pane again each frame.
        section: cn(
          "flex min-h-0 min-w-0 flex-col overflow-hidden will-change-transform [contain:content]",
          raised,
        ),
        header:
          "@container relative flex h-14 shrink-0 border-border/60 bg-card px-2",
        // reach: alone on a phone a folder has no Back or Up either; its path goes up.
        moves: "hidden",
        // Its last rows clear the floating New button.
        body: "min-h-0 flex-1 overflow-y-auto p-4 pb-24 [scrollbar-gutter:stable]",
      },
    };
  return {
    label,
    classes: {
      moves: "",
      section: cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden",
        active
          ? raised
          : cn(
              recessed,
              "rounded-xl ring-1 ring-border/60 dark:ring-white/[0.05]",
            ),
        highlighted &&
          "after:pointer-events-none after:absolute after:inset-0 after:z-20 after:rounded-xl after:bg-primary/[0.06] after:ring-2 after:ring-inset after:ring-primary/45",
      ),
      header: cn(
        "@container relative flex h-14 shrink-0 border-border/60 px-2",
        active
          ? "bg-card"
          : cn(
              recessed,
              "text-muted-foreground [&_[data-slot=breadcrumb-page]]:text-muted-foreground",
            ),
      ),
      body: "min-h-0 flex-1 overflow-y-auto p-4 [scrollbar-gutter:stable]",
    },
  };
}

/** After a pane's path: its sort, grouping and view in one menu, and Close. */
export function PaneTools({
  prefs,
  close,
  onCollapse,
}: {
  prefs: PanePrefs;
  /**
   * Ends this pane or the split, keeping one folder as the page's one folder, and what it says it
   * does: "Close this pane" side by side, "Close split" one pane at a time.
   */
  close: { label: string; run: () => void };
  /** Folds this pane into a strip at its edge, which opens it again; null where panes cannot fold. */
  onCollapse: (() => void) | null;
}) {
  return (
    <>
      <PaneViewMenu prefs={prefs} onCollapse={onCollapse} />
      <Button
        variant="ghost"
        size="icon-compact"
        aria-label={close.label}
        title={close.label}
        onClick={close.run}
        className="touch-hit shrink-0 text-muted-foreground"
      >
        <X className="size-4" />
      </Button>
    </>
  );
}

/**
 * A pane folded away: a narrow strip at its edge that names its folder. The whole strip is one
 * button, and pressing it anywhere opens the pane again; hovering tints it, as it does the
 * page's other controls. Folding is in the pane's own menu (see `PaneTools`).
 */
export function CollapsedPane({
  side,
  label,
  onExpand,
}: {
  side: PaneSide;
  label: string;
  onExpand: () => void;
}) {
  return (
    <section
      data-pane={side}
      data-collapsed
      aria-label={`${sideName[side]} pane (collapsed)`}
      className="flex min-h-0"
    >
      <button
        type="button"
        aria-label={`Expand ${label}`}
        title={`Expand ${label}`}
        onClick={onExpand}
        className={cn(
          "flex min-h-0 w-full cursor-pointer flex-col items-center rounded-xl py-4 text-muted-foreground ring-1 ring-border/60 outline-none transition-colors duration-150 motion-reduce:transition-none dark:ring-white/[0.05]",
          recessed,
          "hover:bg-accent hover:text-foreground active:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <span className="min-h-0 truncate text-xs font-medium [writing-mode:vertical-rl]">
          {label}
        </span>
      </button>
    </section>
  );
}
