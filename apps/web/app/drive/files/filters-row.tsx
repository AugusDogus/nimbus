import type { LucideIcon } from "lucide-react";
import {
  ArrowDownAZ,
  ArrowUpAZ,
  Calendar,
  Check,
  FileText,
  Grid2X2,
  Layers,
  List,
  SlidersHorizontal,
  Weight,
} from "lucide-react";
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

type FiltersRowProps = {
  prefs: UserPreferences;
  view: UserPreferences["view"];
  updatePreferences: (partial: Partial<UserPreferences>) => void;
};

type SortOption = {
  field: UserPreferences["sortField"];
  direction: UserPreferences["sortDirection"];
  label: string;
  icon: LucideIcon;
};

const sortOptions: SortOption[] = [
  {
    field: "name",
    direction: "asc",
    label: "Name (A to Z)",
    icon: ArrowDownAZ,
  },
  { field: "name", direction: "desc", label: "Name (Z to A)", icon: ArrowUpAZ },
  {
    field: "modified",
    direction: "desc",
    label: "Modified (Newest)",
    icon: Calendar,
  },
  {
    field: "modified",
    direction: "asc",
    label: "Modified (Oldest)",
    icon: Calendar,
  },
  { field: "size", direction: "desc", label: "Size (Largest)", icon: Weight },
  { field: "size", direction: "asc", label: "Size (Smallest)", icon: Weight },
  { field: "type", direction: "asc", label: "Type (A to Z)", icon: FileText },
  { field: "type", direction: "desc", label: "Type (Z to A)", icon: FileText },
];

const sortValue = (option: Pick<SortOption, "field" | "direction">) =>
  `${option.field}-${option.direction}`;

export function FiltersRow({
  prefs,
  view,
  updatePreferences,
}: FiltersRowProps) {
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);

  const selectedValue = sortValue({
    field: prefs.sortField,
    direction: prefs.sortDirection,
  });
  const selectedSort =
    sortOptions.find((option) => sortValue(option) === selectedValue) ??
    sortOptions[0];

  return (
    <div className="ml-auto flex shrink-0 items-center gap-2">
      {/* Mobile: single filter button that opens a Drawer */}
      <Button
        variant="ghost"
        size="sm"
        className="md:hidden"
        onClick={() => setFilterDrawerOpen(true)}
        aria-label="Sort and filter options"
      >
        <SlidersHorizontal className="size-4" />
      </Button>

      <Drawer open={filterDrawerOpen} onOpenChange={setFilterDrawerOpen}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Sort &amp; filter</DrawerTitle>
            <DrawerDescription className="sr-only">
              Choose sort order and grouping
            </DrawerDescription>
          </DrawerHeader>
          <div className="flex flex-col gap-1 px-4 pb-6">
            <p className="px-3 pb-1 text-xs font-medium text-muted-foreground">
              Sort by
            </p>
            {sortOptions.map((option) => (
              <DrawerClose
                key={sortValue(option)}
                render={
                  <DrawerActionItem
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
                {sortValue(option) === selectedValue && (
                  <Check className="size-4 text-primary" />
                )}
              </DrawerClose>
            ))}
            <div className="my-2 h-px bg-border" />
            <DrawerActionItem
              onClick={() =>
                updatePreferences({ groupByType: !prefs.groupByType })
              }
            >
              <Layers className="size-5 text-muted-foreground" />
              <span className="flex-1 text-left">Group by type</span>
              {prefs.groupByType && <Check className="size-4 text-primary" />}
            </DrawerActionItem>
          </div>
        </DrawerContent>
      </Drawer>

      {/* Desktop: inline controls */}
      <Select
        value={sortValue(selectedSort)}
        onValueChange={(value) => {
          const option = sortOptions.find(
            (candidate) => sortValue(candidate) === value,
          );
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
          className="hidden w-auto min-w-[140px] border-transparent bg-transparent shadow-none hover:bg-muted md:flex dark:bg-transparent"
        >
          <SelectValue>
            <selectedSort.icon className="size-4" />
            <span>{selectedSort.label}</span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {sortOptions.map((option) => (
            <SelectItem key={sortValue(option)} value={sortValue(option)}>
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
              className="hidden md:inline-flex"
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
        value={view}
        onValueChange={(value) => {
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
                className="size-8 rounded-md px-0 data-checked:bg-card data-checked:shadow-sm dark:data-checked:bg-accent"
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
                className="size-8 rounded-md px-0 data-checked:bg-card data-checked:shadow-sm dark:data-checked:bg-accent"
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
