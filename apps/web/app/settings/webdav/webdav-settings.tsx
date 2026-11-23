import { useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, Laptop, Plus } from "lucide-react";
import { queryClient, trpcClient } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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
import { SettingsRow, SettingsSection } from "../settings-section";
import { CopyField } from "./copy-field";
import { CreatePasswordDialog } from "./create-password-dialog";

// The origin is fixed for the document, but unavailable during server rendering.
const subscribeToOrigin = () => () => {};
const getServerUrl = () => new URL("/dav/", window.location.origin).href;
const getServerSnapshot = () => "";

export function WebDavSettings({ email }: { email: string }) {
  const passwords = useQuery({
    queryKey: ["appPasswords"],
    queryFn: () => trpcClient.appPasswords.list.query(),
  });
  const serverUrl = useSyncExternalStore(
    subscribeToOrigin,
    getServerUrl,
    getServerSnapshot,
  );
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-balance text-2xl font-semibold">WebDAV</h1>
        <p className="max-w-prose text-pretty text-sm text-muted-foreground">
          Connect your files to Finder, a file manager, or any WebDAV client.
        </p>
      </div>
      <SettingsSection
        title="Connection"
        description="Enter these details in your WebDAV client."
      >
        <SettingsRow
          label="Server address"
          description="Your Nimbus server’s WebDAV endpoint."
        >
          <CopyField label="Server address" value={serverUrl} />
        </SettingsRow>
        <SettingsRow
          label="Username"
          description="Use your Nimbus account email."
        >
          <CopyField label="Username" value={email} />
        </SettingsRow>
        <SettingsRow
          label="Password"
          description="Create an app password below for each device."
        >
          <p className="text-pretty text-sm text-muted-foreground">
            Your regular sign-in password won’t work here.
          </p>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection
        title="App passwords"
        description="Each password has the same file permissions as your account."
        action={
          <Button
            size="compact"
            variant="tertiary"
            onClick={() => setCreating(true)}
            leadingIcon={Plus}
          >
            Create password
          </Button>
        }
      >
        {passwords.isPending ? (
          <div
            role="status"
            aria-label="Loading app passwords"
            className="space-y-3 p-5"
          >
            <Skeleton className="h-4 w-40 motion-reduce:animate-none" />
            <Skeleton className="h-3 w-56 motion-reduce:animate-none" />
          </div>
        ) : passwords.error ? (
          <p role="alert" className="p-5 text-pretty text-sm text-destructive">
            {passwords.error.message}
          </p>
        ) : passwords.data.length === 0 ? (
          <div className="flex items-start gap-4 p-5 sm:py-8">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-background">
              <KeyRound
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">No app passwords yet</p>
              <p className="max-w-prose text-pretty text-sm text-muted-foreground">
                Create a password to connect your first device. You can revoke
                it here at any time.
              </p>
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-border/50" aria-label="App passwords">
            {passwords.data.map((password) => (
              <li
                key={password.id}
                className="flex items-center gap-3 px-4 py-4 sm:px-5"
              >
                <Laptop
                  className="size-5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="truncate text-sm font-medium">
                    {password.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Created{" "}
                    <time
                      className="tabular-nums"
                      dateTime={new Date(password.createdAt).toISOString()}
                    >
                      {new Date(password.createdAt).toLocaleDateString(
                        undefined,
                        { dateStyle: "medium" },
                      )}
                    </time>
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="compact"
                  onClick={() => {
                    setError(null);
                    setRevoking(password);
                  }}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
      {creating && <CreatePasswordDialog onClose={() => setCreating(false)} />}
      <AlertDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRevoking(null);
        }}
      >
        <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl [&>*]:min-w-0">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-balance">
              Revoke app password?
            </AlertDialogTitle>
            <AlertDialogDescription className="break-words text-pretty">
              {revoking?.name} will lose access. Your files will remain intact.
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
                if (!revoking) return;
                setBusy(true);
                setError(null);
                void trpcClient.appPasswords.revoke
                  .mutate({ id: revoking.id })
                  .then(async () => {
                    await queryClient.invalidateQueries({
                      queryKey: ["appPasswords"],
                    });
                    setRevoking(null);
                  })
                  .catch((error: unknown) => {
                    setError(
                      error instanceof Error
                        ? error.message
                        : "The password could not be revoked. Try again.",
                    );
                  })
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? "Revoking…" : "Revoke"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
