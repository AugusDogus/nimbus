import { Link } from "@/components/link";
import { useQuery } from "@tanstack/react-query";
import { trpcClient } from "@/lib/trpc";
import { Button, buttonVariants } from "@/components/ui/button";
import { EntriesView } from "./files/entries-view";
import { useEntryDialog } from "./files/use-entry-dialog";
import { useFileActions } from "./files/use-file-actions";
import { useFileDrag } from "./files/use-file-drag";
import { DriveRoot } from "@nimbus/api/drive-root";

export function LibraryPage({
  kind,
}: {
  kind: "starred" | "recent" | "shared";
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
  const active = kind === "shared" ? shared : bookmarks;
  const entries =
    kind === "shared"
      ? (shared.data ?? [])
      : (bookmarks.data ?? []).filter(
          (entry) => kind !== "starred" || entry.starred,
        );
  const actions = useFileActions({ currentPath: "", includeStats: true });
  const drag = useFileDrag(actions);
  const { selection: dialog, select: onDialog } = useEntryDialog(
    kind,
    actions.recordVisit,
  );
  const title =
    kind === "shared"
      ? "Shared with me"
      : kind === "starred"
        ? "Starred"
        : "Recent";
  return (
    <div className="space-y-6">
      {kind !== "shared" && (
        <h1 className="text-balance text-2xl font-semibold">{title}</h1>
      )}
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
            variant="outline"
            size="sm"
            onClick={() => void active.refetch()}
          >
            Try again
          </Button>
        </div>
      )}
      {active.isError && active.data === undefined ? (
        <p role="alert" className="text-pretty text-destructive">
          {active.error.message}
        </p>
      ) : active.isPending ? (
        <p>Loading files…</p>
      ) : entries.length ? (
        <EntriesView
          view="list"
          sections={[{ title: "", entries }]}
          actions={actions}
          drag={drag}
          restoreKey={`${kind}:`}
          label={title}
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
                : "Files you preview and folders you visit will appear here."}
          </p>
          <Link to="/" className={buttonVariants({ variant: "outline" })}>
            Open {DriveRoot.label}
          </Link>
        </div>
      )}
    </div>
  );
}
