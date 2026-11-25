import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { Link } from "@/components/link";
import { useCallback, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TransferDialog } from "../files/entry-dialogs";
import { EntriesView } from "../files/entries-view";
import type { FileEntry } from "../files/types";
import {
  useClashChoices,
  useClashHandoff,
  useEntryDialog,
} from "../files/use-entry-dialog";
import { useFileActions } from "../files/use-file-actions";
import { useFileDrag } from "../files/use-file-drag";
import { FolderLink } from "../files/folder-link";
import { PaneLinks } from "../files/pane-links";
import { SplitLayout } from "../files/split-layout";
import { SplitAddress, useCarriedSplit } from "../files/split/split-address";
import { Highlighted, Location } from "./highlight";
import { SearchTitle } from "./search-title";
import { PageLayout } from "@/components/page-layout";
import { useSearch, type SearchResultEntry } from "./use-search";
import { DriveRoot } from "@nimbus/api/drive-root";
import { EntrySkeleton } from "../files/loading-skeleton";
import { ListOrder } from "../files/list-order";
import { ListHeader, useListFilters } from "../list-filters";

const PAGE = 200;
/**
 * The most matches an order other than relevance sorts. Sorting needs every match, not the
 * pages shown so far, so they all load first; past this many, the search should be narrowed.
 */
const sortCap = 2000;
const count = new Intl.NumberFormat();

export function SearchResultsPage({
  query,
  sort,
}: {
  query: string;
  /** The address's order, absent for relevance. */
  sort: string | undefined;
}) {
  const search = useSearch(query, PAGE);
  const { order, view, filters } = useListFilters("search", sort);
  // An order of its own needs every match. Until they have all loaded, or where there are too
  // many to load, the results stay in relevance order and the page says why.
  const sorting = order.by.kind !== "kept";
  const tooMany =
    sorting && search.total !== null && search.total.count > sortCap;
  const gathering = sorting && !tooMany && search.more;
  const exact = search.total?.exact === true;
  const { loadingMore, loadMore, problem } = search;
  useEffect(() => {
    if (gathering && exact && !loadingMore && !problem) loadMore();
  }, [gathering, exact, loadingMore, problem, loadMore, search.entries.length]);
  const shownOrder = gathering || tooMany ? ListOrder.defaults.search : order;
  const byPath = useMemo(
    () =>
      new Map<string, SearchResultEntry>(
        search.entries.map((entry) => [entry.path, entry]),
      ),
    [search.entries],
  );
  // Stable while the results are, so memoized rows re-render only when their own data changes.
  const renderName = useCallback(
    (entry: FileEntry, view: "list" | "grid") => {
      const hit = byPath.get(entry.path);
      const name = (
        <Highlighted text={entry.name} ranges={hit?.highlight.name ?? []} />
      );
      const place = (
        <Location path={entry.path} ranges={hit?.highlight.folder ?? []} />
      );
      // A card's two lines: the name on one and its folder on the next, so a long folder never
      // pushes the name out.
      return view === "grid" ? (
        <>
          <span className="block truncate">{name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {place}
          </span>
        </>
      ) : (
        <>
          {name}
          <span className="ml-2 text-xs text-muted-foreground">{place}</span>
        </>
      );
    },
    [byPath],
  );
  const clashHandoff = useClashHandoff();
  const actions = useFileActions({
    currentPath: "",
    includeStats: true,
    onClashes: clashHandoff.onClashes,
  });
  const drag = useFileDrag(actions);
  const {
    selection: dialog,
    select: onDialog,
    offer,
  } = useEntryDialog("search", actions.recordVisit);
  useClashChoices(clashHandoff, offer);
  const title = SearchTitle.of(query);
  // Typo and abbreviation matches always rank last, so a heading can separate them.
  // Sorted within each: similar names stay below the matches themselves, in any order.
  const sections = useMemo(() => {
    const similar = search.entries.findIndex(
      (entry) => entry.match === "fuzzy",
    );
    return (
      similar < 0
        ? [{ title: "", entries: search.entries }]
        : [
            { title: "", entries: search.entries.slice(0, similar) },
            { title: "Similar names", entries: search.entries.slice(similar) },
          ].filter((section) => section.entries.length > 0)
    ).map((section) => ({
      ...section,
      entries: ListOrder.apply(section.entries, shownOrder),
    }));
  }, [search.entries, shownOrder]);
  const total = search.total;
  // Searched from a split view: folders opened from here go to its active pane.
  const split = useCarriedSplit();
  const links = useMemo(
    () => (split ? SplitAddress.paneLinks(split, split.layout.active) : null),
    [split],
  );
  return (
    <PaneLinks.Provider value={links}>
      <div className="space-y-6">
        <div className="space-y-1">
          <ListHeader
            title={<h1 className={PageLayout.title}>{title}</h1>}
            filters={filters}
          />
          {split && (
            <p className="text-pretty text-sm text-muted-foreground">
              Folders open in the {split.layout.active} pane of your split view.{" "}
              <FolderLink
                path={SplitLayout.activePath(split.left, split.layout)}
                className="font-medium text-foreground underline-offset-4 hover:underline"
              >
                Back to split view
              </FolderLink>
            </p>
          )}
        </div>
        <TransferDialog
          dialog={dialog}
          actions={actions}
          onClose={() => onDialog(null)}
        />
        {(search.pending || !search.settled) &&
        query &&
        !search.entries.length &&
        !search.problem ? (
          <EntrySkeleton view={view} titled={false} />
        ) : search.entries.length ? (
          <EntriesView
            view={view}
            sections={sections}
            actions={actions}
            drag={drag}
            restoreKey={`search:${query}:${view}`}
            label={title}
            renderName={renderName}
            dialog={dialog}
            onDialog={onDialog}
          />
        ) : search.problem ? null : (
          <div className="space-y-3 rounded-lg border p-8 text-center">
            <p className="text-pretty text-muted-foreground">
              No matching files. Try a different filename.
            </p>
            <Button variant="tertiary" render={<Link to="/" />}>
              Open {DriveRoot.label}
            </Button>
          </div>
        )}
        {/* Said even when the rebuilt list is empty. */}
        {search.restarted && (
          <p
            role="status"
            className="text-pretty text-sm text-muted-foreground"
          >
            The results changed while you were looking through them, so the list
            was rebuilt from the top.
          </p>
        )}
        {/* Results already shown stay; the problem is said below them, calmly when a moment fixes it. */}
        {search.problem && (
          <div className="flex flex-wrap items-center gap-3">
            <p
              role={search.problem.kind === "failed" ? "alert" : "status"}
              className={cn(
                "text-pretty text-sm",
                search.problem.kind === "failed"
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {search.problem.message}
            </p>
            <Button variant="tertiary" size="compact" onClick={search.retry}>
              Search again
            </Button>
          </div>
        )}
        {(gathering || tooMany) && search.entries.length > 0 && (
          <p
            role="status"
            className="text-pretty text-sm text-muted-foreground"
          >
            {tooMany
              ? `Sorting by ${order.label.toLowerCase()} needs every match, and there are more than ${count.format(sortCap)}: the most relevant show first. Narrow the search to sort them.`
              : `Loading every match to sort them by ${order.label.toLowerCase()}…`}
          </p>
        )}
        {!search.complete && (
          <p
            role="status"
            className="text-pretty text-sm text-muted-foreground"
          >
            Nimbus is still indexing your drive after starting. Some matches may
            be missing; search again in a minute.
          </p>
        )}
        {total && search.entries.length > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <p
              role="status"
              className="text-pretty text-sm text-muted-foreground"
            >
              {search.more
                ? `Showing ${count.format(search.entries.length)} of ${count.format(total.count)}${total.exact ? "" : " or more"} matches.`
                : `${count.format(search.entries.length)} ${search.entries.length === 1 ? "match" : "matches"}.`}
            </p>
            {search.more && (
              <Button
                variant="tertiary"
                size="compact"
                className="aria-disabled:opacity-50"
                // Keyboard focus stays on the button while the next page loads, which Base UI's
                // button keeps where this one renders it.
                render={
                  <ButtonPrimitive
                    focusableWhenDisabled
                    disabled={!total.exact || search.loadingMore}
                    onClick={search.loadMore}
                  />
                }
              >
                {search.loadingMore
                  ? "Loading…"
                  : `Show ${count.format(Math.min(PAGE, total.count - search.entries.length))} more`}
              </Button>
            )}
          </div>
        )}
      </div>
    </PaneLinks.Provider>
  );
}
