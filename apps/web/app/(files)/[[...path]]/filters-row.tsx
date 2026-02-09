import type { LucideIcon } from "lucide-react";
import {
    ArrowDownAZ,
    ArrowUpAZ,
    Calendar,
    FileText,
    Grid2X2,
    Layers,
    List,
    Weight,
} from "lucide-react";

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

export function FiltersRow({ prefs, view, updatePreferences }: FiltersRowProps) {
  type SortValue = `${UserPreferences["sortField"]}-${UserPreferences["sortDirection"]}`;
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

  const sortValue = `${prefs.sortField}-${prefs.sortDirection}` as SortValue;
  const selectedSort =
    sortOptions.find((option) => option.value === sortValue) ?? sortOptions[0];

  return (
    <div className="flex flex-wrap items-center gap-2">
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
        <SelectTrigger size="sm" className="w-auto min-w-[140px]">
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
            variant="outline"
            size="sm"
            pressed={prefs.groupByType}
            onPressedChange={(pressed) =>
              updatePreferences({ groupByType: pressed })
            }
            aria-label="Group files by type"
            className={prefs.groupByType ? "bg-accent" : ""}
          >
            <Layers className="size-4" />
            <span className="sm:hidden">Group</span>
          </Toggle>
        </TooltipTrigger>
        <TooltipContent className="hidden sm:block">
          <p>Group by type</p>
        </TooltipContent>
      </Tooltip>

      <ToggleGroup
        type="single"
        value={view}
        onValueChange={(value) => {
          if (value === "grid" || value === "list") {
            updatePreferences({ view: value });
          }
        }}
        variant="outline"
        size="sm"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <ToggleGroupItem
              value="list"
              aria-label="List view"
              className={view === "list" ? "bg-accent" : ""}
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
              className={view === "grid" ? "bg-accent" : ""}
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
