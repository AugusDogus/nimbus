import { useState } from "react";
import { KeyRound } from "lucide-react";
import { queryClient, trpcClient } from "@/lib/trpc";
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
import { CopyField } from "./copy-field";

type PasswordStep =
  | { kind: "create" }
  | { kind: "created"; name: string; token: string };

export function CreatePasswordDialog({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<PasswordStep>({ kind: "create" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy && step.kind === "create") onClose();
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl [&>*]:min-w-0"
        showCloseButton={!busy && step.kind === "create"}
      >
        <DialogHeader className="text-left">
          <KeyRound
            className="mb-2 size-5 text-muted-foreground"
            aria-hidden="true"
          />
          <DialogTitle className="text-balance">
            {step.kind === "created"
              ? "Save your app password"
              : "Create app password"}
          </DialogTitle>
          <DialogDescription className="break-words text-pretty">
            {step.kind === "created"
              ? `Use this password to connect ${step.name}. You won’t be able to view it again.`
              : "Give each device its own password so you can revoke its access independently."}
          </DialogDescription>
        </DialogHeader>
        {step.kind === "created" ? (
          <>
            <div className="space-y-2 py-2">
              <p className="text-sm font-medium">App password</p>
              <CopyField label="App password" value={step.token} />
            </div>
            <DialogFooter>
              <Button onClick={onClose}>I’ve saved it</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="space-y-5"
            onSubmit={(event) =>
              void (async () => {
                event.preventDefault();
                const name = new FormData(event.currentTarget).get("name");
                if (typeof name !== "string") return;
                setBusy(true);
                setError(null);
                try {
                  const result = await trpcClient.appPasswords.create.mutate({
                    name,
                  });
                  setStep({
                    kind: "created",
                    name: name.trim(),
                    token: result.token,
                  });
                  await queryClient.invalidateQueries({
                    queryKey: ["appPasswords"],
                  });
                } catch (error) {
                  setError(
                    error instanceof Error
                      ? error.message
                      : "The app password could not be created. Try again.",
                  );
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            <div className="space-y-2">
              <Label htmlFor="device-name">Device name</Label>
              <Input
                id="device-name"
                name="name"
                placeholder="e.g. MacBook Air"
                required
                pattern=".*\S.*"
                maxLength={100}
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
                variant="tertiary"
                disabled={busy}
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Creating…" : "Create password"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
