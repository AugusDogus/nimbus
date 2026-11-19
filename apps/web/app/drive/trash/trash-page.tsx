import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient, trpcClient } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** `all` lists the items the dialog counts, which are all that emptying deletes. */
type Deletion = { kind: "item"; id: string } | { kind: "all"; ids: string[] };

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

export function TrashPage() {
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
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-balance text-2xl font-semibold">Trash</h1>
          <p className="text-pretty mt-2 text-sm text-muted-foreground">
            Items are kept for 30 days. Restoring an item does not restore its
            old share links or direct permissions.
          </p>
        </div>
        {trash.data && trash.data.length > 0 && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              setDeleting({
                kind: "all",
                ids: trash.data.map((item) => item.id),
              })
            }
          >
            Empty trash
          </Button>
        )}
      </div>
      {(error || trash.error) && (
        <p role="alert" className="text-pretty text-sm text-destructive">
          {error ?? trash.error?.message}
        </p>
      )}
      {trash.isPending ? (
        <p>Loading trash…</p>
      ) : trash.data?.length === 0 ? (
        <p className="text-pretty text-muted-foreground">Trash is empty.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {trash.data?.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1 basis-60">
                <p className="truncate text-sm font-medium">{item.path}</p>
                <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                  Deleted {new Date(item.deletedAt).toLocaleDateString()} ·
                  Expires {new Date(item.expiresAt).toLocaleDateString()}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
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
                size="sm"
                disabled={busy}
                onClick={() => setDeleting({ kind: "item", id: item.id })}
              >
                Delete permanently
              </Button>
            </li>
          ))}
        </ul>
      )}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-balance">
              {deleting?.kind === "all"
                ? "Empty trash?"
                : "Delete permanently?"}
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
    </div>
  );
}
