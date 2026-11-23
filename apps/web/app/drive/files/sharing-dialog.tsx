import { useEffect, useId, useRef, useState } from "react";
import { lazyComponent } from "@/components/lazy-component";
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
import { toast } from "@/lib/toast";
import type { Permission } from "@nimbus/api/drive-store";
import type { FileEntry } from "./types";
import { LinkSettingsDraft, LinkSettingsFields } from "../shared/link-settings";
import {
  HomeFoldersNotice,
  HomesExposureGate,
  useHomesExposure,
} from "../shared/home-folders-notice";
import { DriveRoot } from "@nimbus/api/drive-root";

const permissions: Record<Permission, string> = {
  read: "View and download",
  write: "Edit files",
  admin: "Manage files and sharing",
};

const FileRequestDialog = lazyComponent(
  () => import("../shared/file-request-dialog"),
);

export function SharingDialog({
  entry,
  onClose,
}: {
  entry: Pick<FileEntry, "name" | "path" | "type">;
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
  // Null until a person or group is picked; the select shows its placeholder meanwhile.
  const [subject, setSubject] = useState<string | null>(null);
  const subjects = [
    ...(people.data ?? []).map((person) => ({
      value: `user:${person.id}`,
      label: `${person.name} (${person.email})`,
    })),
    ...(groups.data ?? []).map((group) => ({
      value: `group:${group.id}`,
      label: `Group: ${group.name}`,
    })),
  ];
  const [permission, setPermission] = useState<Permission>("read");
  const [password, setPassword] = useState("");
  const [settings, setSettings] = useState<LinkSettingsDraft>(
    LinkSettingsDraft.empty,
  );
  const [link, setLink] = useState("");
  const linkForm = useId();
  // A new link shows where its settings are, which on a phone can be scrolled out of view.
  const linkField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (link) linkField.current?.scrollIntoView({ block: "nearest" });
  }, [link]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const exposure = useHomesExposure(entry.path);
  const [grantAcknowledged, setGrantAcknowledged] = useState(false);
  const [linkAcknowledged, setLinkAcknowledged] = useState(false);
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
  const createLink = {
    type: "submit",
    "aria-describedby":
      exposure?.kind === "none" ? undefined : "share-link-homes",
    disabled: busy || HomesExposureGate.blocked(exposure, linkAcknowledged),
  } as const;
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
            Grant access to an account or create a public link.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto px-6 pb-6 max-sm:scroll-pb-20">
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              const [type, id] = subject?.split(":") ?? [];
              if (id && (type === "user" || type === "group"))
                void perform(async () => {
                  await trpcClient.access.grant.mutate({
                    path: entry.path,
                    subject: { type, id },
                    permission,
                    ...HomesExposureGate.input(exposure, grantAcknowledged),
                  });
                  setGrantAcknowledged(false);
                });
            }}
          >
            <Label htmlFor="share-person">Person or group</Label>
            <Select
              items={subjects}
              value={subject}
              onValueChange={(value) => setSubject(value)}
            >
              <SelectTrigger id="share-person" className="w-full">
                <SelectValue placeholder="Choose a person or group" />
              </SelectTrigger>
              <SelectContent>
                {subjects.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Label htmlFor="share-permission">Permission</Label>
            <Select
              items={permissions}
              value={permission}
              onValueChange={(value) => {
                if (value !== null) setPermission(value);
              }}
            >
              <SelectTrigger id="share-permission">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(permissions).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <HomeFoldersNotice
              id="share-grant-homes"
              name={entry.path ? entry.name : DriveRoot.label}
              sharing="grant"
              exposure={exposure}
              acknowledged={grantAcknowledged}
              onAcknowledgedChange={setGrantAcknowledged}
            />
            <Button
              type="submit"
              aria-describedby={
                exposure?.kind === "none" ? undefined : "share-grant-homes"
              }
              disabled={
                busy ||
                !subject ||
                HomesExposureGate.blocked(exposure, grantAcknowledged)
              }
            >
              Grant access
            </Button>
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
                  variant="tertiary"
                  size="compact"
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
            id={linkForm}
            className="space-y-3 border-t pt-3"
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                const result = await trpcClient.shares.create.mutate({
                  path: entry.path,
                  ...LinkSettingsDraft.toSettings(settings),
                  ...(password ? { password } : {}),
                  ...HomesExposureGate.input(exposure, linkAcknowledged),
                });
                setLinkAcknowledged(false);
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
            <LinkSettingsFields
              id="share"
              value={settings}
              onChange={setSettings}
            />
            <HomeFoldersNotice
              id="share-link-homes"
              name={entry.path ? entry.name : DriveRoot.label}
              sharing="link"
              exposure={exposure}
              acknowledged={linkAcknowledged}
              onAcknowledgedChange={setLinkAcknowledged}
            />
            <Button
              {...createLink}
              // Phones show this button at the bottom edge instead, below.
              className="max-sm:hidden"
            >
              Create link
            </Button>
            {link && (
              <div className="flex gap-2">
                <Input
                  ref={linkField}
                  aria-label="Share link"
                  value={link}
                  readOnly
                  onFocus={(event) => event.target.select()}
                />
                <Button
                  type="button"
                  variant="tertiary"
                  onClick={() =>
                    void perform(async () => {
                      await navigator.clipboard.writeText(link);
                      toast.success("Link copied");
                    })
                  }
                >
                  Copy
                </Button>
              </div>
            )}
          </form>
          {entry.type === "dir" && (
            <div className="space-y-2 border-t pt-3">
              <p className="text-sm font-medium">File request</p>
              <p className="text-pretty text-sm text-muted-foreground">
                Let people without an account upload into this folder without
                seeing its contents.
              </p>
              <Button
                type="button"
                variant="tertiary"
                onClick={() => setRequesting(true)}
              >
                Request files
              </Button>
            </div>
          )}
          {(error || grants.error || people.error || groups.error) && (
            <p role="alert" className="text-pretty text-sm text-destructive">
              {error ??
                grants.error?.message ??
                people.error?.message ??
                groups.error?.message}
            </p>
          )}
          {/* On phones the dialog scrolls; Create link stays in reach at its bottom edge. Sticking
              24 px below the padded edge puts it on the dialog's own edge. */}
          <div className="sticky -bottom-6 -mx-6 -mb-6 border-t bg-background px-6 py-3 sm:hidden">
            <Button {...createLink} form={linkForm} className="w-full">
              Create link
            </Button>
          </div>
        </div>
        {/* Nested inside the content so Radix treats it as a child layer. */}
        {requesting && (
          <FileRequestDialog
            mode={{ kind: "create", folder: entry }}
            onClose={() => setRequesting(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
