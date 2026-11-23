import { useState } from "react";
import { lazyComponent } from "@/components/lazy-component";
import { useQuery } from "@tanstack/react-query";
import { queryClient, trpcClient } from "@/lib/trpc";
import { toast } from "@/lib/toast";
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
import type { EditableLink } from "./edit-link-dialog";
import { DriveRoot } from "@nimbus/api/drive-root";

// The editor is only needed after a click; keep it out of the page's first load.
const EditLinkDialog = lazyComponent(() => import("./edit-link-dialog"));

export function PublicLinks() {
  const shares = useQuery({
    queryKey: ["shares"],
    queryFn: () => trpcClient.shares.list.query(),
  });
  const [revoking, setRevoking] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditableLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    setError(null);
    try {
      await trpcClient.shares.revoke.mutate({ id: revoking });
      setRevoking(null);
      await queryClient.invalidateQueries({ queryKey: ["shares"] });
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The link could not be revoked. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-6">
      <p className="text-pretty text-sm text-muted-foreground">
        Manage public links you created. Use an item’s Share action to create a
        new link.
      </p>
      {(error || shares.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error ?? shares.error?.message}
        </p>
      )}
      {shares.isPending ? (
        <p>Loading links…</p>
      ) : shares.data?.length === 0 ? (
        <p className="text-muted-foreground">No public links yet.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {shares.data?.map((share) => (
            <li
              key={share.id}
              className="flex flex-wrap items-center gap-3 p-4"
            >
              <div className="min-w-0 flex-1 basis-60">
                <a
                  href={`/s/${share.token}`}
                  className="block truncate text-sm font-medium underline underline-offset-4"
                >
                  {share.path || DriveRoot.label}
                </a>
                <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                  {share.passwordProtected
                    ? "Password required"
                    : "Anyone with the link"}{" "}
                  ·{" "}
                  {share.expiresAt
                    ? `${share.expiresAt <= shares.dataUpdatedAt ? "Expired" : "Expires"} ${new Date(share.expiresAt).toLocaleString()}`
                    : "No expiry"}{" "}
                  ·{" "}
                  {share.maxDownloads === null
                    ? `${share.downloadCount} downloads`
                    : `${share.downloadCount} of ${share.maxDownloads} downloads`}
                  {share.mode === "view" ? " · Preview only" : ""}
                </p>
              </div>
              <Button
                size="compact"
                variant="tertiary"
                onClick={() =>
                  void (async () => {
                    try {
                      await navigator.clipboard.writeText(
                        `${window.location.origin}/s/${share.token}`,
                      );
                      toast.success("Link copied");
                    } catch {
                      setError(
                        "Copy failed. Open the link and copy its address.",
                      );
                    }
                  })()
                }
              >
                Copy link
              </Button>
              <Button
                size="compact"
                variant="tertiary"
                onClick={() => setEditing(share)}
              >
                Edit
              </Button>
              <Button
                size="compact"
                variant="ghost"
                onClick={() => setRevoking(share.id)}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <EditLinkDialog link={editing} onClose={() => setEditing(null)} />
      )}
      <AlertDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRevoking(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-balance">
              Revoke this link?
            </AlertDialogTitle>
            <AlertDialogDescription>
              People using this link will lose access. Your files remain in your
              drive.
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
              disabled={busy}
              onClick={() => {
                void revoke();
              }}
            >
              Revoke link
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
