import {
  PanelLeftOpen,
  PanelRightOpen,
  SlidersHorizontal,
  X,
} from "lucide-react";
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
import { SortOption } from "../sort-option";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DriveRoot } from "@nimbus/api/drive-root";
import type { PaneFailure, PanePrefs } from "../files-page-client";
import type { FolderCardClasses, FolderMoves } from "../folder-card";
import type { PaneSide } from "../split-layout";

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

/** The active pane's card: raised as a page's one card is from 768 px (`PageSurface`). */
const raised =
  "rounded-xl bg-card ring-1 ring-border/80 shadow-raised dark:ring-white/[0.08]";

/**
 * A pane's card: the active one raised and white, the other flatter, tinted and quieter. A drop
 * target is washed and ringed inside, unlike the active pane, which only rises.
 */
export function paneCard(
  side: PaneSide,
  active: boolean,
  highlighted: boolean,
): { label: string; classes: FolderCardClasses } {
  return {
    label: `${sideName[side]} pane${active ? " (active)" : ""}`,
    classes: {
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
  active,
  onClose,
}: {
  prefs: PanePrefs;
  active: boolean;
  /** Closes this pane, keeping the other pane's folder as the page's one folder. */
  onClose: () => void;
}) {
  return (
    <>
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
    </>
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
