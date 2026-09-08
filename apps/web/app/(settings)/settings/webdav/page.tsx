"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient, trpcClient } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

export default function WebDavPage() {
  const passwords = useQuery({
    queryKey: ["appPasswords"],
    queryFn: () => trpcClient.appPasswords.list.query(),
  });
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: ["appPasswords"] });
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The app password could not be updated. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="w-full space-y-6">
      <h1 className="text-balance text-2xl font-semibold">WebDAV</h1>
      <section className="space-y-4 rounded-lg border p-5">
        <h2 className="text-balance text-lg font-medium">
          Connect with WebDAV
        </h2>
        <p className="text-pretty text-sm text-muted-foreground">
          Use this server’s address followed by <code>/dav/</code>, your email
          as the username, and an app password below. Your normal file
          permissions apply.
        </p>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const result = await trpcClient.appPasswords.create.mutate({
                name,
              });
              setToken(result.token);
              setName("");
            });
          }}
        >
          <Label htmlFor="device-name">Device name</Label>
          <div className="flex gap-2">
            <Input
              id="device-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Laptop"
              maxLength={100}
            />
            <Button disabled={busy || !name.trim()}>Create password</Button>
          </div>
        </form>
        {token && (
          <div className="space-y-2 rounded-md bg-muted p-4">
            <Label htmlFor="new-app-password">
              Save this password now. It is shown only once.
            </Label>
            <Input
              id="new-app-password"
              readOnly
              value={token}
              onFocus={(event) => event.target.select()}
            />
            <Button variant="outline" size="sm" onClick={() => setToken("")}>
              I’ve saved it
            </Button>
          </div>
        )}
        {passwords.data?.map((password) => (
          <div
            key={password.id}
            className="flex items-center justify-between gap-3 border-t pt-3"
          >
            <span className="truncate text-sm">{password.name}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRevoking(password.id)}
            >
              Revoke
            </Button>
          </div>
        ))}
      </section>
      {(error || passwords.error) && (
        <p role="alert" className="text-pretty text-sm text-destructive">
          {error ?? passwords.error?.message}
        </p>
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
              Revoke app password?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The connected device will lose access. Your files will remain
              intact.
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
              onClick={(event) => {
                event.preventDefault();
                if (revoking)
                  void run(async () => {
                    await trpcClient.appPasswords.revoke.mutate({
                      id: revoking,
                    });
                    setRevoking(null);
                  });
              }}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
