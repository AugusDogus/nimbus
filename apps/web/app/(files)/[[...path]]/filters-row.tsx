"use client";

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

type SortValue =
  `${UserPreferences["sortField"]}-${UserPreferences["sortDirection"]}`;
type SortOption = {
  value: SortValue;
  label: string;
  icon: LucideIcon;
};

const sortOptions: SortOption[] = [
  { value: "name-asc", label: "Name (A to Z)", icon: ArrowDownAZ },
  { value: "name-desc", label: "Name (Z to A)", icon: ArrowUpAZ },
  { value: "modified-desc", label: "Modified (Newest)", icon: Calendar },
  { value: "modified-asc", label: "Modified (Oldest)", icon: Calendar },
  { value: "size-desc", label: "Size (Largest)", icon: Weight },
  { value: "size-asc", label: "Size (Smallest)", icon: Weight },
  { value: "type-asc", label: "Type (A to Z)", icon: FileText },
  { value: "type-desc", label: "Type (Z to A)", icon: FileText },
];

export function FiltersRow({
  prefs,
  view,
  updatePreferences,
}: FiltersRowProps) {
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);

  const sortValue = `${prefs.sortField}-${prefs.sortDirection}` as SortValue;
  const selectedSort =
    sortOptions.find((option) => option.value === sortValue) ?? sortOptions[0];

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
              <DrawerClose key={option.value} asChild>
                <DrawerActionItem
                  onClick={() => {
                    const [field, direction] = option.value.split("-") as [
                      typeof prefs.sortField,
                      typeof prefs.sortDirection,
                    ];
                    updatePreferences({
                      sortField: field,
                      sortDirection: direction,
                    });
                  }}
                >
                  <option.icon className="size-5 text-muted-foreground" />
                  <span className="flex-1 text-left">{option.label}</span>
                  {option.value === sortValue && (
                    <Check className="size-4 text-primary" />
                  )}
                </DrawerActionItem>
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
        value={selectedSort.value}
        onValueChange={(value) => {
          const [field, direction] = value.split("-") as [
            typeof prefs.sortField,
            typeof prefs.sortDirection,
          ];
          updatePreferences({ sortField: field, sortDirection: direction });
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
            <SelectItem key={option.value} value={option.value}>
              <option.icon className="size-4" />
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            variant="default"
            size="sm"
            pressed={prefs.groupByType}
            onPressedChange={(pressed) =>
              updatePreferences({ groupByType: pressed })
            }
            aria-label="Group files by type"
            className={`hidden md:inline-flex ${prefs.groupByType ? "bg-accent" : ""}`}
          >
            <Layers className="size-4" />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>
          <p>Group by type</p>
        </TooltipContent>
      </Tooltip>

      {/* View toggle is always visible */}
      <ToggleGroup
        aria-label="File view"
        type="single"
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
          <TooltipTrigger asChild>
            <ToggleGroupItem
              value="list"
              aria-label="List view"
              className="size-8 rounded-md px-0 data-[state=on]:bg-card data-[state=on]:shadow-sm dark:data-[state=on]:bg-accent"
            >
              <List className="size-4" />
            </ToggleGroupItem>
          </TooltipTrigger>
          <TooltipContent>
            <p>List view</p>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <ToggleGroupItem
              value="grid"
              aria-label="Grid view"
              className="size-8 rounded-md px-0 data-[state=on]:bg-card data-[state=on]:shadow-sm dark:data-[state=on]:bg-accent"
            >
              <Grid2X2 className="size-4" />
            </ToggleGroupItem>
          </TooltipTrigger>
          <TooltipContent>
            <p>Grid view</p>
          </TooltipContent>
        </Tooltip>
      </ToggleGroup>
    </div>
  );
}
