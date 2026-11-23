import {
  ArrowLeft,
  ArrowUp,
  PanelLeftOpen,
  PanelRightOpen,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { createContext, useContext } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu-choices";
import { DragHint } from "../drag-hint";
import { SortOption } from "../sort-option";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DriveRoot } from "@nimbus/api/drive-root";
import type { PaneFailure, PaneParts, PanePrefs } from "../files-page-client";
import type { PaneSide } from "../split-layout";
import type { FileDrag } from "../use-file-drag";

const sideName = { left: "Left", right: "Right" } as const;

/** Where a pane can go: back to the folder it showed before, up a level, or its top folder. */
export type PaneMoves = {
  back: (() => void) | null;
  up: (() => void) | null;
  top: () => void;
};

/** Why a pane's folder cannot be shown, with ways on that keep the pane open. */
function PaneFailureView({
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
            variant={failure.code === null ? "outline" : "default"}
            onClick={moves.up}
          >
            Open parent
          </Button>
        )}
        <Button variant="outline" onClick={moves.top}>
          Open {DriveRoot.label}
        </Button>
      </div>
    </div>
  );
}

/** What the split view tells a pane's frame about the pane around it. */
export type PaneChrome = {
  id: string;
  side: PaneSide;
  active: boolean;
  drag: FileDrag;
  moves: PaneMoves;
  /** Closes this pane, keeping the other pane's folder as the page's one folder. */
  onClose: () => void;
  onActivate: () => void;
  /** Whether a drag is over this pane, which then says where it would drop. */
  dragOver: boolean;
  onDragOver: () => void;
};

export const PaneChrome = createContext<PaneChrome | null>(null);

/** The inactive pane's surface: the page's tint mixed into the window's, flatter than a card. */
const recessed =
  "bg-[color-mix(in_oklab,var(--background)_45%,var(--sidebar))]";

/** The pane's sort, grouping and view, in one menu. */
function PaneViewMenu({
  prefs: { prefs, updatePreferences },
  muted,
}: {
  prefs: PanePrefs;
  muted: boolean;
}) {
  const sort = SortOption.value({
    field: prefs.sortField,
    direction: prefs.sortDirection,
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Sort and view"
            title="Sort and view"
            className={cn(
              "touch-hit shrink-0",
              muted && "text-muted-foreground",
            )}
          />
        }
      >
        <SlidersHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            Sort by
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={sort}
            onValueChange={(value: unknown) => {
              const option =
                typeof value === "string" ? SortOption.find(value) : undefined;
              if (option)
                updatePreferences({
                  sortField: option.field,
                  sortDirection: option.direction,
                });
            }}
          >
            {SortOption.all.map((option) => (
              <DropdownMenuRadioItem
                key={SortOption.value(option)}
                value={SortOption.value(option)}
              >
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={prefs.groupByType}
          onCheckedChange={(checked) =>
            updatePreferences({ groupByType: checked })
          }
        >
          Group by type
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            View
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={prefs.view}
            onValueChange={(value: unknown) => {
              if (value === "list" || value === "grid")
                updatePreferences({ view: value });
            }}
          >
            <DropdownMenuRadioItem value="list">List</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="grid">Grid</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One pane of a split view: a card of its own, with a header of Back and Up for the pane alone,
 * its path, its sort and view, and Close, then its listing in a scroll area of its own. The pane's
 * folder takes drops on its empty space and header. The active pane, which New, Upload and the
 * page's commands act on, is the raised white card; the other is flatter, tinted and quieter, and
 * its name says it is not the active one.
 */
export function PaneSection({ parts }: { parts: PaneParts }) {
  const chrome = useContext(PaneChrome);
  if (!chrome)
    throw new Error(
      "A split view pane rendered outside its split view. Render FolderPane panes inside SplitView.",
    );
  const { id, side, active, drag, moves, onClose, onActivate } = chrome;
  const { attachToolbar, breadcrumbs, prefs, content, target } = parts;
  const highlighted = drag.dropState(target.path) === "allowed";
  return (
    <section
      id={id}
      data-pane={side}
      data-active={active ? true : undefined}
      aria-label={`${sideName[side]} pane${active ? " (active)" : ""}`}
      aria-current={active ? "true" : undefined}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl ring-1 transition-[background-color,box-shadow] duration-150 ease-out motion-reduce:transition-none",
        active
          ? "bg-card shadow-[0_1px_3px_rgb(30_40_60/0.07),0_12px_32px_-14px_rgb(30_40_60/0.28)] ring-border/80 dark:shadow-[0_1px_2px_rgb(0_0_0/0.35),0_14px_36px_-12px_rgb(0_0_0/0.75)] dark:ring-white/[0.08]"
          : cn(recessed, "ring-border/60 dark:ring-white/[0.05]"),
        // A drop target is washed and ringed inside, unlike the active pane, which only rises.
        highlighted &&
          "after:pointer-events-none after:absolute after:inset-0 after:z-20 after:rounded-xl after:bg-primary/[0.06] after:ring-2 after:ring-inset after:ring-primary/45",
      )}
      onPointerDownCapture={onActivate}
      onFocusCapture={onActivate}
      onDragOverCapture={chrome.onDragOver}
      {...drag.targetProps(target)}
    >
      <div
        ref={attachToolbar}
        className={cn(
          "@container relative z-10 flex h-14 shrink-0 items-center gap-1 border-b border-border/60 px-2",
          // The selection bar takes this colour over (`bg-inherit`), so it is solid.
          active
            ? "bg-card"
            : cn(
                recessed,
                "text-muted-foreground [&_[data-slot=breadcrumb-page]]:text-muted-foreground",
              ),
        )}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          title="Back"
          disabled={!moves.back}
          onClick={() => moves.back?.()}
          className="touch-hit shrink-0"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Up one level"
          title="Up one level"
          disabled={!moves.up}
          onClick={() => moves.up?.()}
          className="touch-hit mr-1 shrink-0"
        >
          <ArrowUp className="size-4" />
        </Button>
        <div className="min-w-0 flex-1 overflow-hidden">{breadcrumbs}</div>
        <PaneViewMenu prefs={prefs} muted={!active} />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close this pane"
          title="Close this pane"
          onClick={onClose}
          className="touch-hit shrink-0 text-muted-foreground"
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-clip p-4 [scrollbar-gutter:stable]">
        {content.kind === "listing" ? (
          content.body
        ) : (
          <PaneFailureView failure={content.failure} moves={moves} />
        )}
      </div>
      <DragHint drag={drag} placement="pane" shown={chrome.dragOver} />
    </section>
  );
}

/** A pane folded away: a narrow card that names its folder and opens it again. */
export function CollapsedPane({
  side,
  label,
  onReopen,
}: {
  side: PaneSide;
  label: string;
  onReopen: () => void;
}) {
  const Icon = side === "left" ? PanelLeftOpen : PanelRightOpen;
  return (
    <section
      data-pane={side}
      data-collapsed
      aria-label={`${sideName[side]} pane (collapsed)`}
      className={cn(
        "flex min-h-0 flex-col items-center gap-3 rounded-xl py-3 ring-1 ring-border/60 dark:ring-white/[0.05]",
        recessed,
      )}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Reopen ${side} pane: ${label}`}
        title={`Reopen ${label}`}
        onClick={onReopen}
        className="touch-hit"
      >
        <Icon className="size-4" />
      </Button>
      <span
        aria-hidden
        className="min-h-0 truncate text-xs font-medium text-muted-foreground [writing-mode:vertical-rl]"
      >
        {label}
      </span>
    </section>
  );
}
