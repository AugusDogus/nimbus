import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ByteSize } from "@/lib/byte-size";
import { queryClient, trpcClient } from "@/lib/trpc";
import type { FileEntry } from "./types";

export default function VersionsDialog({
  entry,
  onClose,
}: {
  entry: Pick<FileEntry, "name" | "path" | "permission">;
  onClose: () => void;
}) {
  const versions = useQuery({
    queryKey: ["versions", entry.path],
    queryFn: () => trpcClient.versions.list.query({ path: entry.path }),
  });
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canRestore = entry.permission !== "read";
  const restore = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await trpcClient.versions.restore.mutate({ path: entry.path, id });
      setConfirming(null);
      await queryClient.invalidateQueries({
        queryKey: ["versions", entry.path],
      });
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The version could not be restored. The current file is unchanged. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] grid-rows-[auto_minmax(0,1fr)] overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle className="min-w-0 break-words pr-6 text-balance">
            Versions of {entry.name}
          </DialogTitle>
          <DialogDescription className="text-pretty">
            Earlier content is kept when the file is replaced, for up to 30
            days.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-3 overflow-y-auto px-6 pb-6">
          {(error || versions.error) && (
            <p role="alert" className="text-pretty text-sm text-destructive">
              {error ?? versions.error?.message}
            </p>
          )}
          {versions.isPending ? (
            <p className="text-sm">Loading versions…</p>
          ) : versions.data?.length === 0 ? (
            <p className="text-pretty text-sm text-muted-foreground">
              No earlier versions. They appear after the file is replaced.
            </p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {versions.data?.map((version) => (
                <li
                  key={version.id}
                  className="flex flex-wrap items-center gap-2 p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium tabular-nums">
                      {new Date(version.modifiedAt).toLocaleString()}
                    </p>
                    <p className="text-xs tabular-nums text-muted-foreground">
                      {ByteSize.format(version.size)}
                      {version.archivedBy
                        ? ` · Replaced by ${version.archivedBy}`
                        : ""}
                    </p>
                  </div>
                  <a
                    href={`/api/files/version?path=${encodeURIComponent(entry.path)}&id=${version.id}`}
                    download
                    className={buttonVariants({
                      variant: "outline",
                      size: "sm",
                    })}
                  >
                    Download
                  </a>
                  {canRestore &&
                    (confirming === version.id ? (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => void restore(version.id)}
                      >
                        Confirm restore
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setConfirming(version.id)}
                      >
                        Restore
                      </Button>
                    ))}
                </li>
              ))}
            </ul>
          )}
          {canRestore && (
            <p className="text-pretty text-xs text-muted-foreground">
              Restoring keeps the current content as a version, so it can be
              undone.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
