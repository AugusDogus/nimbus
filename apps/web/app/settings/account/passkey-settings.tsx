import { useState } from "react";
import { refreshAccount } from "@/lib/account-refresh";
import { CodeLoad, CodeLoadError } from "@/lib/code-load";
import { Fingerprint, Plus } from "lucide-react";
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
} from "@/components/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/field";
import { SettingsSection } from "../settings-section";

export type PasskeySummary = {
  id: string;
  name: string;
  createdAt: number | null;
  synced: boolean;
};

const loadClient = () =>
  CodeLoad.load(() => import("@/lib/passkey-client")).then(
    (module) => module.passkeyAuthClient,
  );
const cancelled = (error: unknown) =>
  error instanceof DOMException &&
  (error.name === "AbortError" || error.name === "NotAllowedError");

export function PasskeySettings({ passkeys }: { passkeys: PasskeySummary[] }) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<PasskeySummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<boolean>) => {
    setBusy(true);
    setError(null);
    try {
      if (await action()) void refreshAccount();
    } catch (cause) {
      setError(
        cancelled(cause)
          ? "The passkey request was cancelled or timed out. Nothing was changed."
          : cause instanceof CodeLoadError
            ? `${cause.message} Nothing was changed.`
            : "The server could not be reached. Nothing was changed. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection
      title="Passkeys"
      description="Sign in with your fingerprint, face, or device PIN instead of a password and code."
      action={
        <Button
          size="compact"
          variant="tertiary"
          onClick={() => {
            setError(null);
            setAdding(true);
          }}
          leadingIcon={Plus}
        >
          Add passkey
        </Button>
      }
    >
      {passkeys.length === 0 ? (
        <div className="flex items-start gap-4 p-5 sm:py-8">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-background">
            <Fingerprint
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">No passkeys yet</p>
            <p className="max-w-prose text-pretty text-sm text-muted-foreground">
              A passkey is stored by your device or password manager and cannot
              be phished. It counts as both factors, so it signs you in without
              a code.
            </p>
          </div>
        </div>
      ) : (
        <ul aria-label="Passkeys" className="divide-y divide-border/50">
          {passkeys.map((passkey) => (
            <li
              key={passkey.id}
              className="flex items-center gap-3 px-4 py-4 sm:px-5"
            >
              <Fingerprint
                className="size-5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1 space-y-1">
                <p className="truncate text-sm font-medium">{passkey.name}</p>
                <p className="text-xs text-muted-foreground">
                  {passkey.synced
                    ? "Synced across devices"
                    : "Stored on one device"}
                  {passkey.createdAt !== null && (
                    <>
                      {" · Added "}
                      <time
                        className="tabular-nums"
                        dateTime={new Date(passkey.createdAt).toISOString()}
                        suppressHydrationWarning
                      >
                        {new Date(passkey.createdAt).toLocaleDateString(
                          undefined,
                          { dateStyle: "medium" },
                        )}
                      </time>
                    </>
                  )}
                </p>
              </div>
              <Button
                variant="ghost"
                size="compact"
                onClick={() => {
                  setError(null);
                  setRemoving(passkey);
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && !adding && !removing && (
        <p
          role="alert"
          className="px-4 py-3 text-pretty text-sm text-destructive sm:px-5"
        >
          {error}
        </p>
      )}
      <Dialog
        open={adding}
        onOpenChange={(open) => !open && !busy && setAdding(false)}
      >
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto [&>*]:min-w-0"
          showCloseButton={!busy}
        >
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              const name = new FormData(event.currentTarget).get("name");
              if (typeof name !== "string") return;
              void run(async () => {
                const client = await loadClient();
                const result = await client.passkey.addPasskey({
                  name: name.trim(),
                });
                if (result?.error) {
                  setError(
                    result.error.message ??
                      "The passkey could not be saved. Try again.",
                  );
                  return false;
                }
                setAdding(false);
                return true;
              });
            }}
          >
            <DialogHeader className="text-left">
              <DialogTitle className="text-balance">Add a passkey</DialogTitle>
              <DialogDescription className="text-pretty">
                Name it after the device or password manager that stores it.
                Your browser will ask you to confirm.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <FieldLabel htmlFor="passkey-name">Passkey name</FieldLabel>
              <Input
                id="passkey-name"
                name="name"
                placeholder="e.g. MacBook Touch ID"
                required
                pattern=".*\S.*"
                maxLength={100}
                disabled={busy}
                autoFocus
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
                onClick={() => setAdding(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Waiting for your device…" : "Continue"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => !open && !busy && setRemoving(null)}
      >
        <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto [&>*]:min-w-0">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-balance">
              Remove passkey?
            </AlertDialogTitle>
            <AlertDialogDescription className="break-words text-pretty">
              {removing?.name} will no longer sign you in to Nimbus. Also delete
              it from your device or password manager.
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
              onClick={() => {
                const target = removing;
                if (!target) return;
                void run(async () => {
                  const client = await loadClient();
                  const result = await client.passkey.deletePasskey({
                    id: target.id,
                  });
                  if (result.error) {
                    setError(
                      result.error.message ??
                        "The passkey could not be removed. Try again.",
                    );
                    return false;
                  }
                  setRemoving(null);
                  return true;
                });
              }}
            >
              {busy ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}
