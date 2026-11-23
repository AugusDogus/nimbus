import { useState } from "react";
import { lazyComponent } from "@/components/lazy-component";
import { useQuery } from "@tanstack/react-query";
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
import { ByteSize } from "@/lib/byte-size";
import { queryClient, trpcClient } from "@/lib/trpc";
import type { EditableFileRequest } from "./file-request-dialog";
import { DriveRoot } from "@nimbus/api/drive-root";

const FileRequestDialog = lazyComponent(() => import("./file-request-dialog"));

export function FileRequests() {
  const requests = useQuery({
    queryKey: ["file-requests"],
    queryFn: () => trpcClient.fileRequests.list.query(),
  });
  const [editing, setEditing] = useState<EditableFileRequest | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    setError(null);
    try {
      await trpcClient.fileRequests.revoke.mutate({ id: revoking });
      setRevoking(null);
      await queryClient.invalidateQueries({ queryKey: ["file-requests"] });
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The upload link could not be revoked. It still works. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-6">
      <p className="text-pretty text-sm text-muted-foreground">
        Upload links let people without an account add files to a folder. Use a
        folder’s Share action to create one.
      </p>
      {(error || requests.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error ?? requests.error?.message}
        </p>
      )}
      {requests.isPending ? (
        <p>Loading upload links…</p>
      ) : requests.data?.length === 0 ? (
        <p className="text-muted-foreground">No upload links yet.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {requests.data?.map((request) => (
            <li
              key={request.id}
              className="flex flex-wrap items-center gap-3 p-4"
            >
              <div className="min-w-0 flex-1 basis-60">
                <a
                  href={`/r/${request.token}`}
                  className="block truncate text-sm font-medium underline underline-offset-4"
                >
                  {request.path || DriveRoot.label}
                </a>
                <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                  {request.passwordProtected
                    ? "Password required"
                    : "Anyone with the link"}{" "}
                  ·{" "}
                  {request.expiresAt
                    ? `${request.expiresAt <= requests.dataUpdatedAt ? "Expired" : "Expires"} ${new Date(request.expiresAt).toLocaleString()}`
                    : "No expiry"}{" "}
                  · {request.received.files}
                  {request.maxFiles === null
                    ? ""
                    : ` of ${request.maxFiles}`}{" "}
                  files, {ByteSize.format(request.received.bytes)}
                  {request.maxTotalBytes === null
                    ? ""
                    : ` of ${ByteSize.format(request.maxTotalBytes)}`}{" "}
                  received
                </p>
              </div>
              <Button
                size="compact"
                variant="tertiary"
                onClick={() => {
                  navigator.clipboard
                    .writeText(`${window.location.origin}/r/${request.token}`)
                    .catch(() =>
                      setError(
                        "Copy failed. Open the link and copy its address.",
                      ),
                    );
                }}
              >
                Copy link
              </Button>
              <Button
                size="compact"
                variant="tertiary"
                onClick={() => setEditing(request)}
              >
                Edit
              </Button>
              <Button
                size="compact"
                variant="ghost"
                onClick={() => setRevoking(request.id)}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <FileRequestDialog
          mode={{ kind: "edit", request: editing }}
          onClose={() => setEditing(null)}
        />
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
              Revoke this upload link?
            </AlertDialogTitle>
            <AlertDialogDescription>
              People can no longer upload with it, and unfinished uploads stop.
              Files already received stay in the folder.
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
