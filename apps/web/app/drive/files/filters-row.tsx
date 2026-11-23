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
  SelectValue,
} from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import type { UserPreferences } from "@nimbus/api/context";
import { SortOption } from "./sort-option";

type FiltersRowProps = {
  prefs: UserPreferences;
  view: UserPreferences["view"];
  updatePreferences: (partial: Partial<UserPreferences>) => void;
};

export function FiltersRow({
  prefs,
  view,
  updatePreferences,
}: FiltersRowProps) {
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);

  const selectedValue = SortOption.value({
    field: prefs.sortField,
    direction: prefs.sortDirection,
  });
  const selectedSort = SortOption.find(selectedValue) ?? SortOption.all[0];

  return (
    <div className="ml-auto flex shrink-0 items-center gap-2">
      {/* Mobile: single filter button that opens a Drawer */}
      <Button
        variant="ghost"
        size="sm"
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
              Choose sort order and grouping
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
              {SortOption.all.map((option) => (
                <DrawerClose
                  key={SortOption.value(option)}
                  render={
                    <DrawerActionItem
                      aria-pressed={SortOption.value(option) === selectedValue}
                      onClick={() => {
                        updatePreferences({
                          sortField: option.field,
                          sortDirection: option.direction,
                        });
                      }}
                    />
                  }
                >
                  <option.icon className="size-5 text-muted-foreground" />
                  <span className="flex-1 text-left">{option.label}</span>
                  {SortOption.value(option) === selectedValue && (
                    <Check aria-hidden className="size-4 text-primary" />
                  )}
                </DrawerClose>
              ))}
            </div>
            <div className="my-2 h-px bg-border" />
            <DrawerActionItem
              aria-pressed={prefs.groupByType}
              onClick={() =>
                updatePreferences({ groupByType: !prefs.groupByType })
              }
            >
              <Layers className="size-5 text-muted-foreground" />
              <span className="flex-1 text-left">Group by type</span>
              {prefs.groupByType && (
                <Check aria-hidden className="size-4 text-primary" />
              )}
            </DrawerActionItem>
          </div>
        </DrawerContent>
      </Drawer>

      {/* Desktop: inline controls */}
      <Select
        value={SortOption.value(selectedSort)}
        onValueChange={(value) => {
          const option = value === null ? undefined : SortOption.find(value);
          if (option)
            updatePreferences({
              sortField: option.field,
              sortDirection: option.direction,
            });
        }}
      >
        <SelectTrigger
          aria-label="Sort files"
          size="sm"
          // In a narrow pane of a split view the order shows as its icon alone, leaving the
          // breadcrumb room; the page itself is no container, so this never applies there.
          className="touch-hit hidden w-auto min-w-[140px] border-transparent bg-transparent shadow-none hover:bg-muted @max-lg:min-w-0 md:flex dark:bg-transparent"
        >
          <SelectValue>
            <selectedSort.icon className="size-4" />
            <span className="@max-lg:sr-only">{selectedSort.label}</span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {SortOption.all.map((option) => (
            <SelectItem
              key={SortOption.value(option)}
              value={SortOption.value(option)}
            >
              <option.icon className="size-4" />
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              variant="default"
              size="sm"
              pressed={prefs.groupByType}
              onPressedChange={(pressed) =>
                updatePreferences({ groupByType: pressed })
              }
              aria-label="Group files by type"
              className="touch-hit hidden md:inline-flex"
            />
          }
        >
          <Layers className="size-4" />
        </TooltipTrigger>
        <TooltipContent>
          <p>Group by type</p>
        </TooltipContent>
      </Tooltip>

      {/* View toggle is always visible */}
      <ToggleGroup
        aria-label="File view"
        value={[view]}
        onValueChange={([value]) => {
          if (value === "grid" || value === "list") {
            updatePreferences({ view: value });
          }
        }}
        variant="default"
        size="sm"
        spacing={1}
        className="rounded-lg bg-muted/70 p-1"
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <ToggleGroupItem
                value="list"
                aria-label="List view"
                className="touch-hit size-8 rounded-md px-0 pointer-coarse:w-11 data-pressed:bg-card data-pressed:shadow-sm dark:data-pressed:bg-accent"
              />
            }
          >
            <List className="size-4" />
          </TooltipTrigger>
          <TooltipContent>
            <p>List view</p>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <ToggleGroupItem
                value="grid"
                aria-label="Grid view"
                className="touch-hit size-8 rounded-md px-0 pointer-coarse:w-11 data-pressed:bg-card data-pressed:shadow-sm dark:data-pressed:bg-accent"
              />
            }
          >
            <Grid2X2 className="size-4" />
          </TooltipTrigger>
          <TooltipContent>
            <p>Grid view</p>
          </TooltipContent>
        </Tooltip>
      </ToggleGroup>
    </div>
  );
}
