import { useState } from "react";
import { KeyRound } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function ResetPasswordDialog({
  user,
  onClose,
}: {
  user: { id: string; email: string };
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl [&>*]:min-w-0"
        showCloseButton={!busy}
      >
        <DialogHeader className="text-left">
          <KeyRound
            className="mb-2 size-5 text-muted-foreground"
            aria-hidden="true"
          />
          <DialogTitle className="text-balance">Reset password</DialogTitle>
          <DialogDescription className="break-words text-pretty">
            Set a new password for {user.email}. Their other browser sessions
            will be signed out.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) =>
            void (async () => {
              event.preventDefault();
              const password = new FormData(event.currentTarget).get(
                "password",
              );
              if (typeof password !== "string") return;
              setBusy(true);
              setError(null);
              try {
                const result = await authClient.admin.setUserPassword({
                  userId: user.id,
                  newPassword: password,
                });
                if (result.error) {
                  setError(
                    result.error.message ??
                      "The password could not be reset. Try again.",
                  );
                  return;
                }
                const sessions = await authClient.admin.revokeUserSessions({
                  userId: user.id,
                });
                if (sessions.error) {
                  setError(
                    "The password was changed, but other browser sessions could not be signed out. Disable the account if access must be stopped immediately.",
                  );
                  return;
                }
                onClose();
              } catch {
                setError(
                  "The server could not be reached. Check the account before trying again.",
                );
              } finally {
                setBusy(false);
              }
            })()
          }
        >
          <div className="space-y-2">
            <Label htmlFor="reset-password">New password</Label>
            <Input
              id="reset-password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={128}
              disabled={busy}
            />
          </div>
          {error && (
            <p role="alert" className="text-pretty text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button disabled={busy}>
              {busy ? "Saving…" : "Reset password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
