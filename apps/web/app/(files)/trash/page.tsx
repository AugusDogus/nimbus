"use client";

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

export default function TrashPage() {
  const trash = useQuery({
    queryKey: ["trash"],
    queryFn: () => trpcClient.trash.list.query(),
  });
  const [deleting, setDeleting] = useState<string | null>(null);
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
      <div>
        <h1 className="text-balance text-2xl font-semibold">Trash</h1>
        <p className="text-pretty mt-2 text-sm text-muted-foreground">
          Items are kept for 30 days. Restoring an item does not restore its old
          share links or direct permissions.
        </p>
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
              <div className="min-w-0 flex-1">
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
                onClick={() => setDeleting(item.id)}
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
              Delete permanently?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This item and its contents cannot be recovered.
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
              onClick={(event) => {
                event.preventDefault();
                if (deleting)
                  void perform(() =>
                    trpcClient.trash.purge.mutate({ id: deleting }),
                  );
              }}
            >
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
