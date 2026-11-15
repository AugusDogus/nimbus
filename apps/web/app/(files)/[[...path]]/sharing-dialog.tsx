"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { queryClient, trpcClient } from "@/lib/trpc";
import type { Permission } from "@nimbus/api/drive-store";
import type { FileEntry } from "./types";

export function SharingDialog({
  entry,
  onClose,
}: {
  entry: Pick<FileEntry, "name" | "path">;
  onClose: () => void;
}) {
  const people = useQuery({
    queryKey: ["people", entry.path],
    queryFn: () => trpcClient.access.people.query({ path: entry.path }),
  });
  const groups = useQuery({
    queryKey: ["groups"],
    queryFn: () => trpcClient.access.groups.query(),
  });
  const grants = useQuery({
    queryKey: ["permissions", entry.path],
    queryFn: () => trpcClient.access.permissions.query({ path: entry.path }),
  });
  const [subject, setSubject] = useState("");
  const [permission, setPermission] = useState<Permission>("read");
  const [password, setPassword] = useState("");
  const [expiry, setExpiry] = useState("");
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await queryClient.invalidateQueries({
        queryKey: ["permissions", entry.path],
      });
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Sharing could not be updated. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] grid-rows-[auto_minmax(0,1fr)] overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle className="min-w-0 break-words pr-6 text-balance">
            Share {entry.name}
          </DialogTitle>
          <DialogDescription>
            Grant access to an account or create a read-only public link.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto px-6 pb-6">
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              const [type, id] = subject.split(":");
              if (id && (type === "user" || type === "group"))
                void perform(() =>
                  trpcClient.access.grant.mutate({
                    path: entry.path,
                    subject: { type, id },
                    permission,
                  }),
                );
            }}
          >
            <Label htmlFor="share-person">Person or group</Label>
            <Select value={subject} onValueChange={setSubject}>
              <SelectTrigger id="share-person" className="w-full">
                <SelectValue placeholder="Choose a person or group" />
              </SelectTrigger>
              <SelectContent>
                {people.data?.map((person) => (
                  <SelectItem key={person.id} value={`user:${person.id}`}>
                    {person.name} ({person.email})
                  </SelectItem>
                ))}
                {groups.data?.map((group) => (
                  <SelectItem key={group.id} value={`group:${group.id}`}>
                    Group: {group.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Label htmlFor="share-permission">Permission</Label>
            <Select
              value={permission}
              onValueChange={(value) => {
                if (value === "read" || value === "write" || value === "admin")
                  setPermission(value);
              }}
            >
              <SelectTrigger id="share-permission">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="read">View and download</SelectItem>
                <SelectItem value="write">Edit files</SelectItem>
                <SelectItem value="admin">Manage files and sharing</SelectItem>
              </SelectContent>
            </Select>
            <Button disabled={busy || !subject}>Grant access</Button>
          </form>
          <div className="space-y-2 border-t pt-3">
            <p className="text-sm font-medium">Direct access</p>
            {grants.data?.length === 0 && (
              <p className="text-pretty text-sm text-muted-foreground">
                No direct grants. Parent folder permissions still apply.
              </p>
            )}
            {grants.data?.map((grant) => (
              <div
                key={grant.id}
                className="flex items-center justify-between gap-2 text-sm"
              >
                <span className="min-w-0 truncate">
                  {grant.subject.type === "user"
                    ? (people.data?.find(
                        (person) => person.id === grant.subject.id,
                      )?.email ?? "User")
                    : (groups.data?.find(
                        (group) => group.id === grant.subject.id,
                      )?.name ?? "Group")}{" "}
                  · {grant.permission}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void perform(() =>
                      trpcClient.access.revoke.mutate({
                        path: entry.path,
                        id: grant.id,
                      }),
                    )
                  }
                >
                  Remove access
                </Button>
              </div>
            ))}
          </div>
          <form
            className="space-y-3 border-t pt-3"
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                const result = await trpcClient.shares.create.mutate({
                  path: entry.path,
                  expiresAt: expiry ? new Date(expiry).getTime() : null,
                  ...(password ? { password } : {}),
                });
                setLink(`${window.location.origin}/s/${result.token}`);
                await queryClient.invalidateQueries({ queryKey: ["shares"] });
              });
            }}
          >
            <p className="text-sm font-medium">Public link</p>
            <Label htmlFor="share-password">Password (optional)</Label>
            <Input
              id="share-password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <Label htmlFor="share-expiry">Expires (optional)</Label>
            <Input
              id="share-expiry"
              type="datetime-local"
              value={expiry}
              onChange={(event) => setExpiry(event.target.value)}
            />
            <Button disabled={busy}>Create link</Button>
            {link && (
              <div className="flex gap-2">
                <Input
                  aria-label="Share link"
                  value={link}
                  readOnly
                  onFocus={(event) => event.target.select()}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    void perform(() => navigator.clipboard.writeText(link))
                  }
                >
                  Copy
                </Button>
              </div>
            )}
          </form>
          {(error || grants.error || people.error || groups.error) && (
            <p role="alert" className="text-pretty text-sm text-destructive">
              {error ??
                grants.error?.message ??
                people.error?.message ??
                groups.error?.message}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
