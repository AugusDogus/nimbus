import type { LucideIcon } from "lucide-react";
import { Clock, Sparkles } from "lucide-react";
import type { UserPreferences } from "@nimbus/api/context";
import { sortEntries } from "./entry-sort";
import { SortOption } from "./sort-option";
import type { FileEntry } from "./types";

/** The listings besides folders: items gathered from many folders. */
export type ListPage = "recent" | "search" | "starred" | "shared";

/**
 * One way to order such a listing: by a field, as a folder sorts, or as the server gives it
 * (`kept`), which is what a page means by "most recent" or "relevance".
 */
export type ListOrder = {
  value: string;
  label: string;
  icon: LucideIcon;
  by:
    | { kind: "kept" }
    | {
        kind: "field";
        field: UserPreferences["sortField"];
        direction: UserPreferences["sortDirection"];
      };
};

const fields: readonly ListOrder[] = SortOption.all.map((option) => ({
  value: SortOption.value(option),
  label: option.label,
  icon: option.icon,
  by: { kind: "field", field: option.field, direction: option.direction },
}));

const mostRecent: ListOrder = {
  value: "recent",
  label: "Most recent",
  icon: Clock,
  by: { kind: "kept" },
};
const relevance: ListOrder = {
  value: "relevance",
  label: "Relevance",
  icon: Sparkles,
  by: { kind: "kept" },
};
const byName: ListOrder = {
  value: "name-asc",
  label: "Name (A to Z)",
  icon: SortOption.all[0]?.icon ?? Clock,
  by: { kind: "field", field: "name", direction: "asc" },
};

/**
 * Each page's default: Recent most recent first (the order its server keeps, by when each item
 * was last opened or starred), search results by relevance, and Starred and Shared by name, as
 * folders start.
 */
const defaults: Record<ListPage, ListOrder> = {
  recent: mostRecent,
  search: relevance,
  starred: byName,
  shared: byName,
};

/**
 * Each page's orders, its default first. Search offers no type order: its results are found by
 * name, and type adds little there.
 */
const forPage: Record<ListPage, readonly ListOrder[]> = {
  recent: [mostRecent, ...fields],
  search: [
    relevance,
    ...fields.filter(
      (order) => order.by.kind !== "field" || order.by.field !== "type",
    ),
  ],
  starred: fields,
  shared: fields,
};

/** The order an address's `sort` names on `page`, or the page's default. */
const pick = (page: ListPage, value: string | undefined): ListOrder =>
  forPage[page].find((order) => order.value === value) ?? defaults[page];

/** The `sort` an address carries for `order`: none for the page's default, so links stay short. */
const param = (page: ListPage, order: ListOrder): string | undefined =>
  order.value === defaults[page].value ? undefined : order.value;

/** `entries` in `order`: as given for a kept order, otherwise sorted as a folder sorts. */
const apply = <T extends FileEntry>(
  entries: readonly T[],
  order: ListOrder,
): readonly T[] =>
  order.by.kind === "kept"
    ? entries
    : sortEntries(entries, {
        sortField: order.by.field,
        sortDirection: order.by.direction,
        groupByType: false,
      });

export const ListOrder = { forPage, defaults, pick, param, apply } as const;
