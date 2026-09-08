"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { trpcClient } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { EntriesView } from "./[[...path]]/entries-view";
import { useFileActions } from "./[[...path]]/use-file-actions";

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
    queryFn: () => trpcClient.catalog.search.query({ query, path: "" }),
    enabled: kind === "search" && query.length > 0,
  });
  const active =
    kind === "search" ? search : kind === "shared" ? shared : bookmarks;
  const entries =
    kind === "search"
      ? (search.data?.entries ?? [])
      : kind === "shared"
        ? (shared.data ?? [])
        : (bookmarks.data ?? []).filter(
            (entry) => kind !== "starred" || entry.starred,
          );
  const actions = useFileActions({ currentPath: "", includeStats: true });
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
          groupByType={false}
          folders={[]}
          files={[]}
          sortedEntries={entries}
          actions={actions}
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
          <Button asChild variant="outline">
            <Link href="/">Open My Drive</Link>
          </Button>
        </div>
      )}
      {kind === "search" && search.data?.truncated && (
        <p className="text-pretty text-sm text-muted-foreground">
          Search reached its scan or result limit. Use a more specific filename
          to narrow the results.
        </p>
      )}
    </div>
  );
}
