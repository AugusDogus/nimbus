import { Link } from "@/components/link";
import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { trpcClient } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { EntriesView } from "./files/entries-view";
import { useEntryDialog } from "./files/use-entry-dialog";
import { useFileActions } from "./files/use-file-actions";
import { Highlighted, parentLabel } from "./search/highlight";

const SEARCH_LIMIT = 200;

export function LibraryPage({
  kind,
  query = "",
}: {
  kind: "starred" | "recent" | "shared" | "search";
  query?: string;
}) {
  const bookmarks = useQuery({
    queryKey: ["catalog", "bookmarks"],
    queryFn: () => trpcClient.catalog.bookmarks.query(),
    enabled: kind === "starred" || kind === "recent",
  });
  const shared = useQuery({
    queryKey: ["catalog", "shared"],
    queryFn: () => trpcClient.catalog.shared.query(),
    enabled: kind === "shared",
  });
  const search = useQuery({
    queryKey: ["catalog", "search", query],
    queryFn: ({ signal }) =>
      trpcClient.catalog.search.query(
        { query, path: "", limit: SEARCH_LIMIT },
        { signal },
      ),
    enabled: kind === "search" && query.length > 0,
  });
  const active =
    kind === "search" ? search : kind === "shared" ? shared : bookmarks;
  // Stable, so memoized rows re-render only when their own data changes.
  const renderSearchName = useCallback(
    (entry: { name: string; path: string }) => (
      <>
        <Highlighted text={entry.name} query={query} />
        <span className="ml-2 text-xs text-muted-foreground">
          {parentLabel(entry.path)}
        </span>
      </>
    ),
    [query],
  );
  const entries =
    kind === "search"
      ? (search.data?.entries ?? [])
      : kind === "shared"
        ? (shared.data ?? [])
        : (bookmarks.data ?? []).filter(
            (entry) => kind !== "starred" || entry.starred,
          );
  const actions = useFileActions({ currentPath: "", includeStats: true });
  const { selection: dialog, select: onDialog } = useEntryDialog(
    kind,
    actions.recordVisit,
  );
  const title =
    kind === "shared"
      ? "Shared with me"
      : kind === "starred"
        ? "Starred"
        : kind === "recent"
          ? "Recent"
          : `Search: ${query}`;
  return (
    <div className="space-y-6">
      {kind !== "shared" && (
        <h1 className="text-balance text-2xl font-semibold">{title}</h1>
      )}
      {active.isError ? (
        <p role="alert" className="text-pretty text-destructive">
          {active.error.message}
        </p>
      ) : active.isPending && (kind !== "search" || query) ? (
        <p>Loading files…</p>
      ) : entries.length ? (
        <EntriesView
          view="list"
          sections={[{ title: "", entries }]}
          actions={actions}
          restoreKey={`${kind}:${query}`}
          label={title}
          renderName={kind === "search" ? renderSearchName : undefined}
          dialog={dialog}
          onDialog={onDialog}
        />
      ) : (
        <div className="space-y-3 rounded-lg border p-8 text-center">
          <p className="text-pretty text-muted-foreground">
            {kind === "starred"
              ? "Star a file or folder from its actions menu to find it here."
              : kind === "shared"
                ? "Files shared with your account or groups will appear here."
                : kind === "recent"
                  ? "Files you preview and folders you visit will appear here."
                  : "No matching files. Try a different filename."}
          </p>
          <Button
            nativeButton={false}
            variant="outline"
            render={<Link to="/" />}
          >
            Open My Drive
          </Button>
        </div>
      )}
      {kind === "search" && search.data?.complete === false && (
        <p role="status" className="text-pretty text-sm text-muted-foreground">
          Nimbus is still indexing your drive after starting. Some matches may
          be missing; search again in a minute.
        </p>
      )}
      {kind === "search" && search.data?.truncated && (
        <p className="text-pretty text-sm text-muted-foreground">
          Showing the first {SEARCH_LIMIT} matches. Type more of the name to
          narrow the results.
        </p>
      )}
    </div>
  );
}
