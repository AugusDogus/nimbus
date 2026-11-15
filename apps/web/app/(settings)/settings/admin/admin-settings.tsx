"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Users } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { trpcClient } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import dynamic from "next/dynamic";
import { UserList } from "./user-list";
import {
  AdminConfirmationDialog,
  type AdminConfirmation,
} from "./admin-confirmation-dialog";
import { SettingsSection } from "../settings-section";
import { CreateAccountDialog } from "./create-account-dialog";
import { GroupDialog, type GroupEditor } from "./group-dialog";
import { ResetPasswordDialog } from "./reset-password-dialog";

// Opens on demand; keep it out of the page's first load.
const SharingDialog = dynamic(() =>
  import("@/app/(files)/[[...path]]/sharing-dialog").then((module) => module.SharingDialog),
);

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
  const [creating, setCreating] = useState(false);
  const [editor, setEditor] = useState<GroupEditor | null>(null);
  const [sharing, setSharing] = useState(false);
  const [resetting, setResetting] = useState<{
    id: string;
    email: string;
  } | null>(null);
  const [confirmation, setConfirmation] = useState<AdminConfirmation | null>(
    null,
  );
  if (me.isPending)
    return (
      <div role="status" aria-label="Loading account" className="space-y-6">
        <Skeleton className="h-8 w-48 motion-reduce:animate-none" />
        <Skeleton className="h-40 w-full rounded-2xl motion-reduce:animate-none" />
      </div>
    );
  if (me.error)
    return (
      <p role="alert" className="text-pretty text-sm text-destructive">
        {me.error.message}
      </p>
    );
  if (!me.data.isAdmin)
    return <p role="alert">Only server administrators can open this page.</p>;
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-balance text-2xl font-semibold">
          Users &amp; groups
        </h1>
        <p className="max-w-prose text-pretty text-sm text-muted-foreground">
          Manage who can sign in and how they access your files.
        </p>
      </div>
      <SettingsSection
        title="Users"
        description="Accounts on this Nimbus server."
        action={
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" />
            Create account
          </Button>
        }
      >
        {users.isPending ? (
          <div
            role="status"
            aria-label="Loading users"
            className="space-y-3 p-5"
          >
            <Skeleton className="h-4 w-48 motion-reduce:animate-none" />
            <Skeleton className="h-3 w-64 motion-reduce:animate-none" />
          </div>
        ) : users.error ? (
          <p role="alert" className="p-5 text-pretty text-sm text-destructive">
            {users.error.message}
          </p>
        ) : (
          <UserList
            users={users.data}
            currentUserId={me.data.id}
            onResetPassword={setResetting}
            onConfirm={setConfirmation}
          />
        )}
      </SettingsSection>
      <SettingsSection
        title="Groups"
        description="Give a set of people the same folder permissions."
        action={
          <Button
            size="sm"
            variant="outline"
            disabled={!users.isSuccess}
            onClick={() => setEditor({ kind: "create" })}
          >
            <Plus aria-hidden="true" />
            Create group
          </Button>
        }
      >
        {groups.isPending ? (
          <div role="status" aria-label="Loading groups" className="p-5">
            <Skeleton className="h-10 w-full motion-reduce:animate-none" />
          </div>
        ) : groups.error ? (
          <p role="alert" className="p-5 text-pretty text-sm text-destructive">
            {groups.error.message}
          </p>
        ) : groups.data.length === 0 ? (
          <div className="flex items-start gap-4 p-5 sm:py-8">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-background">
              <Users
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">No groups yet</p>
              <p className="max-w-prose text-pretty text-sm text-muted-foreground">
                Create a group for a team or project, then share folders with
                everyone in it.
              </p>
            </div>
          </div>
        ) : (
          <ul aria-label="Groups" className="divide-y divide-border/50">
            {groups.data.map((group) => (
              <li
                key={group.id}
                className="flex items-center gap-3 px-4 py-4 sm:px-5"
              >
                <Users
                  className="size-5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="truncate text-sm font-medium">{group.name}</p>
                  <p className="text-xs tabular-nums text-muted-foreground">
                    {group.memberIds.length}{" "}
                    {group.memberIds.length === 1 ? "member" : "members"}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!users.isSuccess}
                  onClick={() => setEditor({ kind: "edit", group })}
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setConfirmation({
                      title: "Delete group and revoke its access?",
                      description: `Members of ${group.name} will lose permissions granted through this group. Other access and files will remain intact.`,
                      action: async () => {
                        await trpcClient.access.removeGroup.mutate({
                          id: group.id,
                        });
                      },
                    });
                  }}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
      <SettingsSection title="Drive access">
        <div className="flex flex-col items-start justify-between gap-4 px-4 py-5 sm:flex-row sm:items-center sm:px-5">
          <div className="space-y-1">
            <p className="text-sm font-medium">Who can access My Drive</p>
            <p className="max-w-prose text-pretty text-sm text-muted-foreground">
              New accounts start without file access. Grant permissions to the
              drive or share individual folders.
            </p>
          </div>
          <Button
            variant="outline"
            className="shrink-0"
            onClick={() => setSharing(true)}
          >
            Manage drive access
          </Button>
        </div>
      </SettingsSection>
      {creating && <CreateAccountDialog onClose={() => setCreating(false)} />}
      {editor && users.data && (
        <GroupDialog
          editor={editor}
          users={users.data}
          onClose={() => setEditor(null)}
        />
      )}
      {resetting && (
        <ResetPasswordDialog
          user={resetting}
          onClose={() => setResetting(null)}
        />
      )}
      {sharing && (
        <SharingDialog
          entry={{ name: "My Drive", path: "", type: "dir" }}
          onClose={() => setSharing(false)}
        />
      )}
      {confirmation && (
        <AdminConfirmationDialog
          confirmation={confirmation}
          onClose={() => setConfirmation(null)}
        />
      )}
    </div>
  );
}
