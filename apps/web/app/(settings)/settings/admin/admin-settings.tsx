"use client";

import { ResetPasswordDialog } from "./reset-password-dialog";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { queryClient, trpcClient } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SharingDialog } from "@/app/(files)/[[...path]]/sharing-dialog";
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

export function AdminSettings() {
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => trpcClient.access.me.query(),
  });
  const users = useQuery({
    queryKey: ["admin", "users"],
    enabled: me.data?.isAdmin === true,
    queryFn: async () => {
      const result = await authClient.admin.listUsers({
        query: { limit: 1000 },
      });
      if (result.error)
        throw new Error(result.error.message ?? "Could not load users.");
      return result.data.users;
    },
  });
  const groups = useQuery({
    queryKey: ["groups"],
    queryFn: () => trpcClient.access.groups.query(),
    enabled: me.data?.isAdmin === true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [resetting, setResetting] = useState<{
    id: string;
    email: string;
  } | null>(null);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    action: () => Promise<void>;
  } | null>(null);
  const [groupId, setGroupId] = useState<string | undefined>();
  const [groupName, setGroupName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setConfirmation(null);
      await queryClient.invalidateQueries({ queryKey: ["admin"] });
      await queryClient.invalidateQueries({ queryKey: ["groups"] });
      await queryClient.invalidateQueries({ queryKey: ["people"] });
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The administrative change failed. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  if (me.isPending) return <p>Loading account…</p>;
  if (!me.data?.isAdmin)
    return <p role="alert">Only server administrators can open this page.</p>;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-balance text-2xl font-semibold">
          Users &amp; groups
        </h1>
        <Button variant="outline" onClick={() => setSharing(true)}>
          Manage drive access
        </Button>
      </div>
      {(error || users.error || groups.error) && (
        <p role="alert" className="text-pretty text-sm text-destructive">
          {error ?? users.error?.message ?? groups.error?.message}
        </p>
      )}
      <section className="space-y-4 rounded-lg border p-5">
        <h2 className="text-balance text-lg font-medium">Create account</h2>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            const name = data.get("name");
            const email = data.get("email");
            const password = data.get("password");
            if (
              typeof name === "string" &&
              typeof email === "string" &&
              typeof password === "string"
            )
              void run(async () => {
                const result = await authClient.admin.createUser({
                  name,
                  email,
                  password,
                  role: "user",
                });
                if (result.error)
                  throw new Error(
                    result.error.message ?? "Could not create account.",
                  );
                form.reset();
              });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="new-user-name">Name</Label>
            <Input name="name" id="new-user-name" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-user-email">Email</Label>
            <Input name="email" id="new-user-email" type="email" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-user-password">Initial password</Label>
            <Input
              name="password"
              id="new-user-password"
              type="password"
              minLength={8}
              autoComplete="new-password"
              required
            />
          </div>
          <Button className="self-end" disabled={busy}>
            Create account
          </Button>
        </form>
        <p className="text-pretty text-sm text-muted-foreground">
          New accounts have no file access until you share a folder or grant
          drive access.
        </p>
      </section>
      <section className="space-y-3">
        <h2 className="text-balance text-lg font-medium">Users</h2>
        {users.data?.map((user) => (
          <div
            key={user.id}
            className="flex flex-wrap items-center gap-3 rounded-lg border p-4"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{user.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {user.email} · {user.role ?? "user"}
                {user.banned ? " · disabled" : ""}
              </p>
            </div>
            {user.id !== me.data.id && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    setResetting({ id: user.id, email: user.email })
                  }
                >
                  Reset password
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    setConfirmation({
                      title: user.banned
                        ? "Enable account?"
                        : "Disable account?",
                      action: async () => {
                        const result = user.banned
                          ? await authClient.admin.unbanUser({
                              userId: user.id,
                            })
                          : await authClient.admin.banUser({ userId: user.id });
                        if (result.error)
                          throw new Error(
                            result.error.message ?? "Could not update account.",
                          );
                      },
                    })
                  }
                >
                  {user.banned ? "Enable" : "Disable"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    setConfirmation({
                      title: "Change administrator access?",
                      action: async () => {
                        const result = await authClient.admin.setRole({
                          userId: user.id,
                          role: user.role === "admin" ? "user" : "admin",
                        });
                        if (result.error)
                          throw new Error(
                            result.error.message ?? "Could not change role.",
                          );
                      },
                    })
                  }
                >
                  {user.role === "admin" ? "Remove admin" : "Make admin"}
                </Button>
              </>
            )}
          </div>
        ))}
      </section>
      <section className="space-y-4 rounded-lg border p-5">
        <h2 className="text-balance text-lg font-medium">Groups</h2>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await trpcClient.access.saveGroup.mutate({
                id: groupId,
                name: groupName,
                memberIds: members,
              });
              setGroupId(undefined);
              setGroupName("");
              setMembers([]);
            });
          }}
        >
          <Label htmlFor="group-name">Group name</Label>
          <Input
            id="group-name"
            required
            value={groupName}
            onChange={(event) => setGroupName(event.target.value)}
          />
          <fieldset className="max-h-48 space-y-2 overflow-auto">
            <legend className="mb-2 text-sm font-medium">Members</legend>
            {users.data?.map((user) => (
              <label key={user.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={members.includes(user.id)}
                  onChange={(event) =>
                    setMembers(
                      event.target.checked
                        ? [...members, user.id]
                        : members.filter((id) => id !== user.id),
                    )
                  }
                />
                {user.name} ({user.email})
              </label>
            ))}
          </fieldset>
          <Button disabled={busy}>
            {groupId ? "Save group" : "Create group"}
          </Button>
          {groupId && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setGroupId(undefined);
                setGroupName("");
                setMembers([]);
              }}
            >
              Cancel edit
            </Button>
          )}
        </form>
        {groups.data?.map((group) => (
          <div key={group.id} className="flex items-center gap-3 border-t pt-3">
            <p className="min-w-0 flex-1 truncate text-sm">
              {group.name} · {group.memberIds.length} members
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setGroupId(group.id);
                setGroupName(group.name);
                setMembers(group.memberIds);
              }}
            >
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setConfirmation({
                  title: "Delete group and revoke its access?",
                  action: async () => {
                    await trpcClient.access.removeGroup.mutate({
                      id: group.id,
                    });
                    if (groupId === group.id) {
                      setGroupId(undefined);
                      setGroupName("");
                      setMembers([]);
                    }
                  },
                })
              }
            >
              Delete
            </Button>
          </div>
        ))}
      </section>
      {resetting && (
        <ResetPasswordDialog
          user={resetting}
          onClose={() => setResetting(null)}
        />
      )}
      {sharing && (
        <SharingDialog
          entry={{ name: "My Drive", path: "" }}
          onClose={() => setSharing(false)}
        />
      )}
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-balance">
              {confirmation?.title}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This changes access to the server or its files. Existing files
              remain on disk.
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
                if (confirmation) void run(confirmation.action);
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
