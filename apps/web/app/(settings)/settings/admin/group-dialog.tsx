"use client";

import { useState } from "react";
import { Users } from "lucide-react";
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

export type GroupEditor =
  | { kind: "create" }
  | { kind: "edit"; group: { id: string; name: string; memberIds: string[] } };

export function GroupDialog({
  editor,
  users,
  onClose,
}: {
  editor: GroupEditor;
  users: { id: string; name: string; email: string }[];
  onClose: () => void;
}) {
  const [name, setName] = useState(
    editor.kind === "edit" ? editor.group.name : "",
  );
  const [members, setMembers] = useState<string[]>(
    editor.kind === "edit" ? editor.group.memberIds : [],
  );
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
          <Users
            className="mb-2 size-5 text-muted-foreground"
            aria-hidden="true"
          />
          <DialogTitle className="text-balance">
            {editor.kind === "edit" ? "Edit group" : "Create group"}
          </DialogTitle>
          <DialogDescription className="break-words text-pretty">
            Share folders with a group to give all its members the same access.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await trpcClient.access.saveGroup.mutate({
                id: editor.kind === "edit" ? editor.group.id : undefined,
                name,
                memberIds: members,
              });
              await Promise.all([
                queryClient.invalidateQueries({ queryKey: ["groups"] }),
                queryClient.invalidateQueries({ queryKey: ["people"] }),
              ]);
              onClose();
            } catch (error) {
              setError(
                error instanceof Error
                  ? error.message
                  : "The group could not be saved. Try again.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="group-name">Group name</Label>
            <Input
              id="group-name"
              required
              disabled={busy}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <fieldset disabled={busy} className="min-w-0 space-y-3">
            <legend className="text-sm font-medium">
              Members{" "}
              <span className="ml-1 font-normal tabular-nums text-muted-foreground">
                {members.length} selected
              </span>
            </legend>
            <div className="max-h-64 divide-y divide-border/50 overflow-y-auto rounded-xl border border-border/60">
              {users.map((user) => (
                <label
                  key={user.id}
                  className="flex cursor-pointer items-center gap-3 px-3 py-3 hover:bg-accent/50"
                >
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    checked={members.includes(user.id)}
                    onChange={(event) =>
                      setMembers(
                        event.target.checked
                          ? [...members, user.id]
                          : members.filter((id) => id !== user.id),
                      )
                    }
                    aria-label={`${user.name} (${user.email})`}
                  />
                  <span className="min-w-0 space-y-0.5">
                    <span className="block truncate text-sm font-medium">
                      {user.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {user.email}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
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
              {busy
                ? "Saving…"
                : editor.kind === "edit"
                  ? "Save group"
                  : "Create group"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
