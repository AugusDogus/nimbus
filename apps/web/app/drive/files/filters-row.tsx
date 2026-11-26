import { Check, Grid2X2, Layers, List, SlidersHorizontal } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { DrawerActionItem } from "@/components/drawer-action-item";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip } from "@/components/ui/tooltip";

import type { LucideIcon } from "lucide-react";
import type { UserPreferences } from "@nimbus/api/context";
import { SortOption } from "./sort-option";
import { SplitRoom } from "./split-room";
import { cn } from "@/lib/utils";

/** The views a listing offers, in the sort and filter drawer. */
const views = [
  { value: "list", label: "List view", icon: List },
  { value: "grid", label: "Grid view", icon: Grid2X2 },
] as const;

/** One order a listing's sort control offers. */
export type SortChoice = { value: string; label: string; icon: LucideIcon };

/** A listing's sort and view controls: a folder's, or a page gathering items from many. */
export type FiltersRowProps = {
  /** The orders the listing offers, the chosen one's value, and how to choose another. */
  sort: {
    choices: readonly SortChoice[];
    value: string;
    onChange: (value: string) => void;
  };
  /** List or grid, where the listing has cards to show; null where it lists rows only. */
  view: {
    current: UserPreferences["view"];
    onChange: (view: UserPreferences["view"]) => void;
  } | null;
  /** Folders first, where the listing groups by type; null where it does not. */
  group: { on: boolean; onChange: (on: boolean) => void } | null;
};

/** A folder's controls, from the account's preferences. */
export function folderFilters(
  prefs: UserPreferences,
  updatePreferences: (partial: Partial<UserPreferences>) => void,
): FiltersRowProps {
  return {
    sort: {
      choices: SortOption.all.map((option) => ({
        value: SortOption.value(option),
        label: option.label,
        icon: option.icon,
      })),
      value: SortOption.value({
        field: prefs.sortField,
        direction: prefs.sortDirection,
      }),
      onChange: (value) => {
        const option = SortOption.find(value);
        if (option)
          updatePreferences({
            sortField: option.field,
            sortDirection: option.direction,
          });
      },
    },
    view: {
      current: prefs.view,
      onChange: (view) => updatePreferences({ view }),
    },
    group: {
      on: prefs.groupByType,
      onChange: (on) => updatePreferences({ groupByType: on }),
    },
  };
}

export function FiltersRow({
  sort,
  view,
  group,
  inlineView = "always",
}: FiltersRowProps & {
  /**
   * Where the view's toggle shows in the row: at every width, or only where a window has room
   * for two panes (`SplitRoom`), as a folder alone, whose own Split takes its place on a phone;
   * there the sort and filter drawer offers the view instead.
   */
  inlineView?: "always" | "wide";
}) {
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);

  const selectedValue = sort.value;
  const selectedSort =
    sort.choices.find((choice) => choice.value === selectedValue) ??
    sort.choices[0];

  return (
    <div className="ml-auto flex shrink-0 items-center gap-2">
      {/* Mobile: single filter button that opens a Drawer */}
      <Button
        variant="ghost"
        size="compact"
        // reach: from 768 px the sort menu and grouping toggle beside it
        className="touch-hit md:hidden"
        onClick={() => setFilterDrawerOpen(true)}
        aria-label="Sort and filter options"
      >
        <SlidersHorizontal className="size-4" />
      </Button>

      <Drawer
        showSwipeHandle
        open={filterDrawerOpen}
        onOpenChange={setFilterDrawerOpen}
      >
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Sort &amp; filter</DrawerTitle>
            <DrawerDescription className="sr-only">
              {[
                "Choose sort order",
                ...(group ? ["grouping"] : []),
                ...(view && inlineView === "wide" ? ["view"] : []),
              ].join(", ")}
            </DrawerDescription>
          </DrawerHeader>
          <div className="flex flex-col gap-1 px-4 pb-6">
            <p
              id="sort-drawer-label"
              className="px-3 pb-1 text-xs font-medium text-muted-foreground"
            >
              Sort by
            </p>
            <div
              role="group"
              aria-labelledby="sort-drawer-label"
              className="flex flex-col gap-1"
            >
              {sort.choices.map((option) => (
                <DrawerClose
                  key={option.value}
                  render={
                    <DrawerActionItem
                      aria-pressed={option.value === selectedValue}
                      onClick={() => sort.onChange(option.value)}
                    />
                  }
                >
                  <option.icon className="size-5 text-muted-foreground" />
                  <span className="flex-1 text-left">{option.label}</span>
                  {option.value === selectedValue && (
                    <Check aria-hidden className="size-4 text-primary" />
                  )}
                </DrawerClose>
              ))}
            </div>
            {group && (
              <>
                <div className="my-2 h-px bg-border" />
                <DrawerActionItem
                  aria-pressed={group.on}
                  onClick={() => group.onChange(!group.on)}
                >
                  <Layers className="size-5 text-muted-foreground" />
                  <span className="flex-1 text-left">Group by type</span>
                  {group.on && (
                    <Check aria-hidden className="size-4 text-primary" />
                  )}
                </DrawerActionItem>
              </>
            )}
            {/* The view, where the row's toggle gives way on a phone (`inlineView`). */}
            {view && inlineView === "wide" && (
              <>
                <div className="my-2 h-px bg-border" />
                <p
                  id="view-drawer-label"
                  className="px-3 pb-1 text-xs font-medium text-muted-foreground"
                >
                  View
                </p>
                <div
                  role="group"
                  aria-labelledby="view-drawer-label"
                  className="flex flex-col gap-1"
                >
                  {views.map((option) => (
                    <DrawerClose
                      key={option.value}
                      render={
                        <DrawerActionItem
                          aria-pressed={option.value === view.current}
                          onClick={() => view.onChange(option.value)}
                        />
                      }
                    >
                      <option.icon className="size-5 text-muted-foreground" />
                      <span className="flex-1 text-left">{option.label}</span>
                      {option.value === view.current && (
                        <Check aria-hidden className="size-4 text-primary" />
                      )}
                    </DrawerClose>
                  ))}
                </div>
              </>
            )}
          </div>
        </DrawerContent>
      </Drawer>

      {/* Desktop: inline controls */}
      <Select
        size="compact"
        value={selectedSort?.value ?? ""}
        onValueChange={sort.onChange}
      >
        {/* The trigger renders inside a wrapper of its own, which takes the row's place. */}
        {/* reach: below 768 px the sort and filter drawer */}
        <div className="hidden md:flex">
          <SelectTrigger
            aria-label="Sort files"
            data-shape="sort"
            variant="borderless"
            icon={selectedSort?.icon}
            // In a narrow pane of a split view the order shows as its icon alone, leaving the
            // breadcrumb room; the page itself is no container, so this never applies there.
            className="touch-hit w-auto min-w-[140px] @max-lg:min-w-0 @max-lg:[&>span>span]:sr-only"
          />
        </div>
        <SelectContent className="max-w-[var(--available-width)]">
          {sort.choices.map((option, index) => (
            <SelectItem
              key={option.value}
              index={index}
              value={option.value}
              icon={option.icon}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {group && (
        <Tooltip content="Group by type">
          <Toggle
            variant="default"
            size="sm"
            pressed={group.on}
            onPressedChange={group.onChange}
            aria-label="Group files by type"
            data-shape="group"
            // reach: below 768 px the sort and filter drawer
            className="touch-hit hidden md:inline-flex"
          >
            <Layers className="size-4" />
          </Toggle>
        </Tooltip>
      )}

      {/* The view, where the listing has one to choose: in the row at every width, or where it
          gives way to a folder's own Split on a phone (`inlineView`). */}
      {view && (
        <ToggleGroup
          aria-label="File view"
          data-shape="view"
          value={[view.current]}
          onValueChange={([value]) => {
            if (value === "grid" || value === "list") view.onChange(value);
          }}
          variant="default"
          size="sm"
          spacing={1}
          className={cn(
            "rounded-lg bg-muted/70 p-1",
            // reach: below the split's widest phone window the sort and filter drawer offers it.
            inlineView === "wide" && SplitRoom.sideBySideOnly,
          )}
        >
          <Tooltip content="List view">
            <ToggleGroupItem
              value="list"
              aria-label="List view"
              className="touch-hit size-8 rounded-md px-0 pointer-coarse:w-11 data-pressed:bg-card data-pressed:shadow-sm dark:data-pressed:bg-accent"
            >
              <List className="size-4" />
            </ToggleGroupItem>
          </Tooltip>
          <Tooltip content="Grid view">
            <ToggleGroupItem
              value="grid"
              aria-label="Grid view"
              className="touch-hit size-8 rounded-md px-0 pointer-coarse:w-11 data-pressed:bg-card data-pressed:shadow-sm dark:data-pressed:bg-accent"
            >
              <Grid2X2 className="size-4" />
            </ToggleGroupItem>
          </Tooltip>
        </ToggleGroup>
      )}
    </div>
  );
}
