import { useState } from "react";
import { queryClient } from "@/lib/trpc";
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

export type AdminConfirmation = {
  title: string;
  description: string;
  action: () => Promise<void>;
  /** The confirm button's label; "Confirm" when omitted. */
  confirmLabel?: string;
};

export function AdminConfirmationDialog({
  confirmation,
  onClose,
}: {
  confirmation: AdminConfirmation;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl [&>*]:min-w-0">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-balance">
            {confirmation.title}
          </AlertDialogTitle>
          <AlertDialogDescription className="break-words text-pretty">
            {confirmation.description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-pretty text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={() =>
              void (async () => {
                setBusy(true);
                setError(null);
                try {
                  await confirmation.action();
                  await Promise.all([
                    queryClient.invalidateQueries({ queryKey: ["admin"] }),
                    queryClient.invalidateQueries({ queryKey: ["groups"] }),
                    queryClient.invalidateQueries({ queryKey: ["people"] }),
                  ]);
                  onClose();
                } catch (error) {
                  setError(
                    error instanceof Error
                      ? error.message
                      : "The administrative change failed. Try again.",
                  );
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            {busy ? "Saving…" : (confirmation.confirmLabel ?? "Confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
