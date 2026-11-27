import { DriveRoot } from "@nimbus/api/drive-root";
import { BreadcrumbTrail } from "../files/breadcrumb-trail";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient, trpcClient, trpc } from "@/lib/trpc";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageLayout } from "@/components/page-layout";
import { FiltersRow } from "../files/filters-row";
import { pageTitles, useAddressSort } from "../list-filters";
import { EmptyListing } from "../files/empty-listing";
import { FolderCard, useBackOnly } from "../files/folder-card";
import { TrashOrder } from "./trash-order";
import {
  TrashIntro,
  TrashShape,
  TrashSkeleton,
  trashFilters,
} from "./trash-shape";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/alert-dialog";

/** `all` lists the items the dialog counts, which are all that emptying deletes. */
type Deletion = { kind: "item"; id: string } | { kind: "all"; ids: string[] };

/** Trash has no selection to cover its header (see `FolderCard`). */
const noToolbar = () => undefined;

/** Ids per request: 5,000 ids are about 200 KB, well under the 1 MB limit on tRPC bodies. */
const emptyBatch = 5_000;

/** Permanently delete the confirmed items, a batch at a time, saying how far it got on failure. */
async function emptyConfirmed(ids: readonly string[]) {
  let deleted = 0;
  for (let start = 0; start < ids.length; start += emptyBatch) {
    try {
      const batch = ids.slice(start, start + emptyBatch);
      deleted += (await trpcClient.trash.empty.mutate({ ids: batch })).deleted;
    } catch (error) {
      // Some items may be gone already; show what is left.
      void queryClient.invalidateQueries({ queryKey: ["trash"] });
      const reason =
        error instanceof Error ? error.message : "The server did not say why.";
      throw new Error(
        start === 0
          ? reason
          : `Deleted ${deleted.toLocaleString()} of ${ids.length.toLocaleString()} items, then stopped: ${reason} The rest are still in trash; empty it again to delete them.`,
      );
    }
  }
}

export function TrashPage({
  sort,
}: {
  /** The address's order, absent for the most recently deleted first. */
  sort: string | undefined;
}) {
  const order = TrashOrder.pick(sort);
  const top = useQuery(trpc.access.me.queryOptions()).data?.top ?? "";
  const choose = useAddressSort();
  const trash = useQuery({
    queryKey: ["trash"],
    queryFn: () => trpcClient.trash.list.query(),
  });
  const capabilities = useQuery({
    queryKey: ["capabilities", ""],
    queryFn: () => trpcClient.access.capabilities.query({ path: "" }),
  });
  const [deleting, setDeleting] = useState<Deletion | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setDeleting(null);
      await queryClient.invalidateQueries({ queryKey: ["trash"] });
      await queryClient.invalidateQueries({ queryKey: ["files.list"] });
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The trash operation failed. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  const moves = useBackOnly();
  const dialogs = (
    <AlertDialog
      open={deleting !== null}
      onOpenChange={(open) => {
        if (!open && !busy) setDeleting(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-balance">
            {deleting?.kind === "all" ? "Empty trash?" : "Delete permanently?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {deleting?.kind === "all"
              ? `${deleting.ids.length === 1 ? "1 item" : `${deleting.ids.length} items`} and ${deleting.ids.length === 1 ? "its" : "their"} contents will be permanently deleted${capabilities.data?.isAdmin ? ", including items other people deleted" : ""}. This cannot be undone.`
              : "This item and its contents cannot be recovered."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={() => {
              if (deleting?.kind === "item")
                void perform(() =>
                  trpcClient.trash.purge.mutate({ id: deleting.id }),
                );
              if (deleting?.kind === "all")
                // Only what the dialog counted, never items trashed since.
                void perform(() => emptyConfirmed(deleting.ids));
            }}
          >
            {deleting?.kind === "all" ? "Empty trash" : "Delete permanently"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return (
    <FolderCard
      pane={null}
      attachToolbar={noToolbar}
      moves={moves}
      breadcrumbs={<h1 className={PageLayout.cardTitle}>{pageTitles.trash}</h1>}
      tools={
        <div className={TrashShape.tools}>
          <FiltersRow {...trashFilters(sort, choose)} />
          {/* Always in place, so the title beside it never narrows when items arrive; there is
            nothing to empty while they load, or once Trash is empty. */}
          <Button
            variant="tertiary"
            size="compact"
            className="touch-hit"
            disabled={busy || !trash.data?.length}
            onClick={() =>
              setDeleting({
                kind: "all",
                ids: (trash.data ?? []).map((item) => item.id),
              })
            }
          >
            {TrashShape.emptyLabel}
          </Button>
        </div>
      }
      body={
        <div className="space-y-6">
          <TrashIntro />
          {(error || trash.error) && (
            <p role="alert" className="text-pretty text-sm text-destructive">
              {error ?? trash.error?.message}
            </p>
          )}
          {trash.isPending ? (
            <TrashSkeleton />
          ) : trash.data?.length === 0 ? (
            <EmptyListing icon={Trash2} title="Trash is empty" />
          ) : (
            <ul className={TrashShape.list}>
              {TrashOrder.apply(trash.data ?? [], order).map((item) => (
                <li key={item.id} data-trash-item className={TrashShape.item}>
                  <div className={TrashShape.itemText}>
                    {/* The name first, so a long location never hides which item it is. */}
                    <p className={TrashShape.path}>
                      {DriveRoot.nameOf(item.path)}
                      <span className={TrashShape.place}>
                        {BreadcrumbTrail.spell(
                          item.path.slice(
                            0,
                            Math.max(item.path.lastIndexOf("/"), 0),
                          ),
                          top,
                        )}
                      </span>
                    </p>
                    <p className={TrashShape.dates}>
                      Deleted {new Date(item.deletedAt).toLocaleDateString()} ·
                      Expires {new Date(item.expiresAt).toLocaleDateString()}
                    </p>
                  </div>
                  <Button
                    variant="tertiary"
                    size="compact"
                    disabled={busy}
                    onClick={() =>
                      void perform(() =>
                        trpcClient.trash.restore.mutate({ id: item.id }),
                      )
                    }
                  >
                    Restore
                  </Button>
                  <Button
                    variant="ghost"
                    size="compact"
                    disabled={busy}
                    onClick={() => setDeleting({ kind: "item", id: item.id })}
                  >
                    Delete permanently
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {dialogs}
        </div>
      }
    />
  );
}
