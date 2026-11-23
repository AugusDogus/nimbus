import type { LucideIcon } from "lucide-react";
import {
  ArrowDownAZ,
  ArrowUpAZ,
  Calendar,
  FileText,
  Weight,
} from "lucide-react";
import type { UserPreferences } from "@nimbus/api/context";

/** One way to order a listing, as the sort menus offer it. */
export type SortOption = {
  field: UserPreferences["sortField"];
  direction: UserPreferences["sortDirection"];
  label: string;
  icon: LucideIcon;
};

const all: readonly SortOption[] = [
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

/** The menus' value for an order, such as `name-asc`. */
const value = (option: Pick<SortOption, "field" | "direction">) =>
  `${option.field}-${option.direction}`;

/** The option a menu value names, if any. */
const find = (selected: string) =>
  all.find((option) => value(option) === selected);

export const SortOption = { all, value, find } as const;
