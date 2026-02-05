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
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={`${prefs.sortField}-${prefs.sortDirection}`}
        onValueChange={(value) => {
          const [field, direction] = value.split("-") as [
            typeof prefs.sortField,
            typeof prefs.sortDirection,
          ];
          updatePreferences({ sortField: field, sortDirection: direction });
        }}
      >
        <SelectTrigger size="sm" className="w-auto min-w-[140px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="name-asc">
            <ArrowDownAZ className="size-4" />
            Name (A to Z)
          </SelectItem>
          <SelectItem value="name-desc">
            <ArrowUpAZ className="size-4" />
            Name (Z to A)
          </SelectItem>
          <SelectItem value="modified-desc">
            <Calendar className="size-4" />
            Modified (Newest)
          </SelectItem>
          <SelectItem value="modified-asc">
            <Calendar className="size-4" />
            Modified (Oldest)
          </SelectItem>
          <SelectItem value="size-desc">
            <Weight className="size-4" />
            Size (Largest)
          </SelectItem>
          <SelectItem value="size-asc">
            <Weight className="size-4" />
            Size (Smallest)
          </SelectItem>
          <SelectItem value="type-asc">
            <FileText className="size-4" />
            Type (A to Z)
          </SelectItem>
          <SelectItem value="type-desc">
            <FileText className="size-4" />
            Type (Z to A)
          </SelectItem>
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
