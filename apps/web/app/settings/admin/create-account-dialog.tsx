import { useState } from "react";
import { UserPlus } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { queryClient } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldLabel } from "@/components/ui/field";

export function CreateAccountDialog({ onClose }: { onClose: () => void }) {
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
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto [&>*]:min-w-0"
        showCloseButton={!busy}
      >
        <DialogHeader className="text-left">
          <UserPlus
            className="mb-2 size-5 text-muted-foreground"
            aria-hidden="true"
          />
          <DialogTitle className="text-balance">Create account</DialogTitle>
          <DialogDescription className="break-words text-pretty">
            Add someone to Nimbus. Share a folder or grant drive access when
            they’re ready.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) =>
            void (async () => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const name = data.get("name");
              const email = data.get("email");
              const password = data.get("password");
              if (
                typeof name !== "string" ||
                typeof email !== "string" ||
                typeof password !== "string"
              )
                return;
              setBusy(true);
              setError(null);
              try {
                const result = await authClient.admin.createUser({
                  name,
                  email,
                  password,
                  role: "user",
                });
                if (result.error) {
                  setError(
                    result.error.message ??
                      "The account could not be created. Try again.",
                  );
                  return;
                }
                await Promise.all([
                  queryClient.invalidateQueries({
                    queryKey: ["admin", "users"],
                  }),
                  queryClient.invalidateQueries({ queryKey: ["people"] }),
                ]);
                onClose();
              } catch {
                setError(
                  "The server could not be reached. Check the user list before trying again.",
                );
              } finally {
                setBusy(false);
              }
            })()
          }
        >
          <div className="space-y-2">
            <FieldLabel htmlFor="new-user-name">Name</FieldLabel>
            <Input
              name="name"
              id="new-user-name"
              autoComplete="off"
              required
              disabled={busy}
            />
          </div>
          <div className="space-y-2">
            <FieldLabel htmlFor="new-user-email">Email</FieldLabel>
            <Input
              name="email"
              id="new-user-email"
              type="email"
              autoComplete="off"
              required
              disabled={busy}
            />
          </div>
          <div className="space-y-2">
            <FieldLabel htmlFor="new-user-password">
              Initial password
            </FieldLabel>
            <Input
              name="password"
              id="new-user-password"
              type="password"
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
              required
              disabled={busy}
            />
            <p className="text-pretty text-xs text-muted-foreground">
              At least 8 characters. Send it to them securely.
            </p>
          </div>
          {error && (
            <p role="alert" className="text-pretty text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="tertiary"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create account"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
