import { Link } from "@/components/link";
import { useCallback, useMemo } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { Highlighted, parentLabel } from "./highlight";
import { useSearch, type SearchResultEntry } from "./use-search";
import { DriveRoot } from "@nimbus/api/drive-root";

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
          <h1 className="text-balance text-2xl font-semibold">{title}</h1>
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
          <p>Loading files…</p>
        ) : search.entries.length ? (
          <EntriesView
            view="list"
            sections={sections}
            actions={actions}
            drag={drag}
            restoreKey={`search:${query}`}
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
            <Link to="/" className={buttonVariants({ variant: "outline" })}>
              Open {DriveRoot.label}
            </Link>
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
            <Button variant="outline" size="sm" onClick={search.retry}>
              Search again
            </Button>
          </div>
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
                variant="outline"
                size="sm"
                // Keyboard focus stays on the button while the next page loads.
                focusableWhenDisabled
                className="aria-disabled:opacity-50"
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
    </PaneLinks.Provider>
  );
}
