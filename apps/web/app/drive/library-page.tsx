import { Link } from "@/components/link";
import { useQuery } from "@tanstack/react-query";
import { Clock, Star, Users } from "lucide-react";
import type { ReactNode } from "react";
import { trpcClient } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { PageLayout } from "@/components/page-layout";
import { EntrySkeleton } from "./files/loading-skeleton";
import { TransferDialog } from "./files/entry-dialogs";
import { EntriesView } from "./files/entries-view";
import { EmptyListing } from "./files/empty-listing";
import { FiltersRow } from "./files/filters-row";
import { FolderCard, useBackOnly, useToolbarSlot } from "./files/folder-card";
import {
  useClashChoices,
  useClashHandoff,
  useEntryDialog,
} from "./files/use-entry-dialog";
import { useFileActions } from "./files/use-file-actions";
import { useFileDrag } from "./files/use-file-drag";
import { DriveRoot } from "@nimbus/api/drive-root";
import { ListOrder } from "./files/list-order";
import { pageTitles, useListFilters } from "./list-filters";

/** What a list page puts on a card: the tools after its title, its header row, its listing. */
export type ListCardParts = {
  tools: ReactNode;
  attachToolbar: (element: HTMLDivElement | null) => void;
  body: ReactNode;
};

const empty = {
  starred: {
    icon: Star,
    title: "No starred items",
    description: "Star a file or folder from its actions menu to find it here.",
  },
  shared: {
    icon: Users,
    title: "Nothing shared with you",
    description: "Files shared with your account or groups will appear here.",
  },
  recent: {
    icon: Clock,
    title: "Nothing opened yet",
    description: "Files you preview and folders you visit will appear here.",
  },
} as const;

export function LibraryPage({
  kind,
  sort,
  frame,
}: {
  kind: "starred" | "recent" | "shared";
  /** The address's order, absent for the page's default (see `useListFilters`). */
  sort: string | undefined;
  /** The card around the listing where the page has its own, as Shared's, around its tabs. */
  frame?: (parts: ListCardParts) => ReactNode;
}) {
  const { order, view, filters } = useListFilters(kind, sort);
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
  const active = kind === "shared" ? shared : bookmarks;
  const entries =
    kind === "shared"
      ? (shared.data ?? [])
      : (bookmarks.data ?? []).filter(
          (entry) => kind !== "starred" || entry.starred,
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
  } = useEntryDialog(kind, actions.recordVisit);
  useClashChoices(clashHandoff, offer);
  const moves = useBackOnly();
  const { toolbarRef, selectionSlot, attach } = useToolbarSlot();
  const label = kind === "shared" ? "Shared with me" : pageTitles[kind];
  const body = (
    <div className="space-y-6">
      {/* A failed refresh keeps the list it already has, and the selection in it. */}
      {active.isError && active.data !== undefined && (
        <div className="flex flex-wrap items-center gap-3">
          <p
            role="status"
            className="text-pretty text-sm text-muted-foreground"
          >
            Could not refresh this list. Showing what was loaded before.
          </p>
          <Button
            variant="tertiary"
            size="compact"
            onClick={() => void active.refetch()}
          >
            Try again
          </Button>
        </div>
      )}
      <TransferDialog
        dialog={dialog}
        actions={actions}
        onClose={() => onDialog(null)}
      />
      {active.isError && active.data === undefined ? (
        <p role="alert" className="text-pretty text-destructive">
          {active.error.message}
        </p>
      ) : active.isPending ? (
        <EntrySkeleton view={view} titled={false} />
      ) : entries.length ? (
        <EntriesView
          view={view}
          sections={[{ title: "", entries: ListOrder.apply(entries, order) }]}
          actions={actions}
          drag={drag}
          restoreKey={`${kind}:${view}`}
          label={label}
          toolbarRef={toolbarRef}
          selectionSlot={selectionSlot}
          dialog={dialog}
          onDialog={onDialog}
        />
      ) : (
        <EmptyListing
          {...empty[kind]}
          action={
            <Button variant="tertiary" render={<Link to="/" />}>
              Open {DriveRoot.label}
            </Button>
          }
        />
      )}
    </div>
  );
  // As a folder's: on a phone the sort and filter drawer offers the view.
  const tools = <FiltersRow {...filters} inlineView="wide" />;
  return frame ? (
    frame({ tools, attachToolbar: attach, body })
  ) : (
    <FolderCard
      pane={null}
      attachToolbar={attach}
      moves={moves}
      breadcrumbs={<h1 className={PageLayout.cardTitle}>{label}</h1>}
      tools={tools}
      body={body}
    />
  );
}
