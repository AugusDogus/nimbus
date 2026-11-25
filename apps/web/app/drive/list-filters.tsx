import { useLocation, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { UserPreferences } from "@nimbus/api/context";
import { SearchParams } from "@/client/search-params";
import { FiltersRow, type FiltersRowProps } from "./files/filters-row";
import { ListOrder, type ListPage } from "./files/list-order";
import { useFilePreferences } from "./files/use-file-preferences";

/**
 * A list page's controls for an order and a view, choosing with `choose`: the page's sort
 * choices, and the account's view. The server's skeleton draws them choosing nothing.
 */
export function listFilters(
  page: ListPage,
  sort: string | undefined,
  view: UserPreferences["view"],
  choose: {
    order: (sort: string | undefined) => void;
    view: (view: UserPreferences["view"]) => void;
  },
): FiltersRowProps {
  return {
    sort: {
      choices: ListOrder.forPage[page],
      value: ListOrder.pick(page, sort).value,
      onChange: (value) =>
        choose.order(ListOrder.param(page, ListOrder.pick(page, value))),
    },
    view: { current: view, onChange: choose.view },
    group: null,
  };
}

/**
 * The sort and view of a page that gathers items from many folders: Recent, Starred, Shared with
 * me, and search results. The view is the account's own, the one folders show, so files look the
 * same wherever they are listed. The order is the page's: its address carries it (`sort`, absent
 * for the page's default), so a link shows what the person saw, and the next visit or search
 * starts from the page's default again, as most recent first on Recent and relevance on search.
 */
export function useListFilters(page: ListPage, sort: string | undefined) {
  const navigate = useNavigate();
  const location = useLocation();
  const { prefs, updatePreferences } = useFilePreferences(true);
  const filters = listFilters(page, sort, prefs.view, {
    order: (next) => {
      const rest = Object.fromEntries(
        Object.entries(location.search).filter(([key]) => key !== "sort"),
      );
      void navigate({
        href: `${location.pathname}${SearchParams.stringify(next ? { ...rest, sort: next } : rest)}`,
        replace: true,
        resetScroll: false,
      });
    },
    view: (view) => updatePreferences({ view }),
  });
  return { order: ListOrder.pick(page, sort), view: prefs.view, filters };
}

/**
 * A list page's title, if it shows one, taking the row's room, and its sort and view controls at
 * the row's end. The server's skeleton draws the same row with a placeholder title.
 */
export function ListHeader({
  title,
  filters,
}: {
  title: ReactNode;
  filters: FiltersRowProps;
}) {
  return (
    <div data-shape="list-header" className="flex min-h-9 items-center gap-3">
      <div className="min-w-0 flex-1">{title}</div>
      <FiltersRow {...filters} />
    </div>
  );
}
