import type { LucideIcon } from "lucide-react";
import { ArrowDownAZ, ArrowUpAZ, CalendarX, Trash2 } from "lucide-react";

/** What Trash lists of a deleted item. */
type TrashItem = { path: string; deletedAt: number; expiresAt: number };

/**
 * One way to order Trash. Its items are paths with when they were deleted and when they go for
 * good, so it orders by those and by name; it keeps no size or modification time.
 */
export type TrashOrder = {
  value: string;
  label: string;
  icon: LucideIcon;
  compare: (a: TrashItem, b: TrashItem) => number;
};

const nameOf = (item: TrashItem) => item.path.split("/").at(-1) ?? item.path;

const all: readonly [TrashOrder, ...TrashOrder[]] = [
  {
    value: "deleted-desc",
    label: "Deleted (Newest)",
    icon: Trash2,
    compare: (a, b) => b.deletedAt - a.deletedAt,
  },
  {
    value: "deleted-asc",
    label: "Deleted (Oldest)",
    icon: Trash2,
    compare: (a, b) => a.deletedAt - b.deletedAt,
  },
  {
    value: "expires-asc",
    label: "Expires (Soonest)",
    icon: CalendarX,
    compare: (a, b) => a.expiresAt - b.expiresAt,
  },
  {
    value: "name-asc",
    label: "Name (A to Z)",
    icon: ArrowDownAZ,
    compare: (a, b) => nameOf(a).localeCompare(nameOf(b)),
  },
  {
    value: "name-desc",
    label: "Name (Z to A)",
    icon: ArrowUpAZ,
    compare: (a, b) => nameOf(b).localeCompare(nameOf(a)),
  },
];

/** The default: the most recently deleted first, what someone looking for a mistake wants. */
const [byDeleted] = all;

/** The order an address's `sort` names, or the default. */
const pick = (value: string | undefined): TrashOrder =>
  all.find((order) => order.value === value) ?? byDeleted;

/** The `sort` an address carries for `order`: none for the default. */
const param = (order: TrashOrder): string | undefined =>
  order.value === byDeleted.value ? undefined : order.value;

/** `items` in `order`. Trash loads whole, so this is every item in that order. */
const apply = <T extends TrashItem>(items: readonly T[], order: TrashOrder) =>
  [...items].sort(order.compare);

export const TrashOrder = { all, pick, param, apply } as const;
