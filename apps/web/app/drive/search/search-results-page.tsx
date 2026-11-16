import { Link } from "@/components/link";
import { useCallback, useMemo } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { EntriesView } from "../files/entries-view";
import type { FileEntry } from "../files/types";
import { useEntryDialog } from "../files/use-entry-dialog";
import { useFileActions } from "../files/use-file-actions";
import { Highlighted, parentLabel } from "./highlight";
import { useSearch, type SearchResultEntry } from "./use-search";

const PAGE = 200;
const count = new Intl.NumberFormat();

export function SearchResultsPage({ query }: { query: string }) {
  const search = useSearch(query, PAGE);
  const byPath = useMemo(
    () =>
      new Map<string, SearchResultEntry>(
        search.entries.map((entry) => [entry.path, entry]),
      ),
    [search.entries],
  );
  // Stable while the results are, so memoized rows re-render only when their own data changes.
  const renderName = useCallback(
    (entry: FileEntry) => {
      const hit = byPath.get(entry.path);
      return (
        <>
          <Highlighted text={entry.name} ranges={hit?.highlight.name ?? []} />
          <span className="ml-2 text-xs text-muted-foreground">
            <Highlighted
              text={parentLabel(entry.path)}
              ranges={hit?.highlight.folder ?? []}
            />
          </span>
        </>
      );
    },
    [byPath],
  );
  const actions = useFileActions({ currentPath: "", includeStats: true });
  const { selection: dialog, select: onDialog } = useEntryDialog(
    "search",
    actions.recordVisit,
  );
  const title = `Search: ${query}`;
  // Typo and abbreviation matches always rank last, so a heading can separate them.
  const sections = useMemo(() => {
    const similar = search.entries.findIndex(
      (entry) => entry.match === "fuzzy",
    );
    return similar < 0
      ? [{ title: "", entries: search.entries }]
      : [
          { title: "", entries: search.entries.slice(0, similar) },
          { title: "Similar names", entries: search.entries.slice(similar) },
        ].filter((section) => section.entries.length > 0);
  }, [search.entries]);
  const total = search.total;
  return (
    <div className="space-y-6">
      <h1 className="text-balance text-2xl font-semibold">{title}</h1>
      {search.error ? (
        <p role="alert" className="text-pretty text-destructive">
          {search.error.message}
        </p>
      ) : (search.pending || !search.settled) &&
        query &&
        !search.entries.length ? (
        <p>Loading files…</p>
      ) : search.entries.length ? (
        <EntriesView
          view="list"
          sections={sections}
          actions={actions}
          restoreKey={`search:${query}`}
          label={title}
          renderName={renderName}
          dialog={dialog}
          onDialog={onDialog}
        />
      ) : (
        <div className="space-y-3 rounded-lg border p-8 text-center">
          <p className="text-pretty text-muted-foreground">
            No matching files. Try a different filename.
          </p>
          <Link to="/" className={buttonVariants({ variant: "outline" })}>
            Open My Drive
          </Link>
        </div>
      )}
      {!search.complete && (
        <p role="status" className="text-pretty text-sm text-muted-foreground">
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
              variant="outline"
              size="sm"
              disabled={!total.exact || search.loadingMore}
              onClick={search.loadMore}
            >
              {search.loadingMore
                ? "Loading…"
                : `Show ${count.format(Math.min(PAGE, total.count - search.entries.length))} more`}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
