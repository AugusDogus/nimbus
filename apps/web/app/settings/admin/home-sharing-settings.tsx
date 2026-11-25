import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { FieldLabel } from "@/components/ui/field";
import { queryClient, trpcClient } from "@/lib/trpc";
import type { AdminConfirmation } from "./admin-confirmation-dialog";
import { SettingsSection } from "../settings-section";
import { DriveRoot } from "@nimbus/api/drive-root";

const queryKey = ["admin", "home-container-sharing"];

type Review = Awaited<
  ReturnType<typeof trpcClient.access.homeContainerSharing.query>
>;
type Entry = {
  kind: "grant" | "link" | "uploadLink";
  id: string;
  label: string;
};

const place = (path: string) => (path ? `"${path}"` : DriveRoot.label);
const homes = (count: number) =>
  `${count} ${count === 1 ? "home folder" : "home folders"}`;

function entries(review: Review): Entry[] {
  return [
    ...review.records.grants.map((grant) => ({
      kind: "grant" as const,
      id: grant.id,
      label: `${grant.subject} has ${grant.permission} access to ${place(grant.path)}`,
    })),
    ...review.records.links.map((link) => ({
      kind: "link" as const,
      id: link.id,
      label: `Public link to ${place(link.path)}, created by ${link.createdBy}`,
    })),
    ...review.records.fileRequests.map((request) => ({
      kind: "uploadLink" as const,
      id: request.id,
      label: `Upload link for ${place(request.path)}, created by ${request.createdBy}`,
    })),
  ];
}

const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The setting could not be changed. Nothing was changed. Try again.";

/**
 * "Allow sharing the home folders container": off by default, turned on only after a
 * confirmation, with the sharing that reaches every home folder listed for review.
 */
export function HomeSharingSettings({
  onConfirm,
}: {
  onConfirm: (confirmation: AdminConfirmation) => void;
}) {
  const review = useQuery({
    queryKey,
    queryFn: () => trpcClient.access.homeContainerSharing.query(),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const save = async (allowed: boolean) => {
    await trpcClient.access.setHomeContainerSharing.mutate({ allowed });
    await queryClient.invalidateQueries({ queryKey });
    await queryClient.invalidateQueries({
      queryKey: ["home-folders-exposure"],
    });
  };
  const remove = (entry: Entry) =>
    trpcClient.access.removeHomeContainerSharing.mutate({
      kind: entry.kind,
      id: entry.id,
    });
  const run = async (action: () => Promise<void>, done: string) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await action();
      setStatus(done);
    } catch (thrown) {
      setError(errorText(thrown));
    } finally {
      setBusy(false);
    }
  };
  if (review.isPending)
    return (
      <SettingsSection title="Home folders">
        <p className="px-4 py-4 text-sm sm:px-5">
          Loading home folder settings…
        </p>
      </SettingsSection>
    );
  if (review.error)
    return (
      <SettingsSection title="Home folders">
        <p
          role="alert"
          className="px-4 py-4 text-pretty text-sm text-destructive sm:px-5"
        >
          {review.error.message}
        </p>
      </SettingsSection>
    );
  const { allowed, containers } = review.data;
  const container = containers.map((path) => `"${path}"`).join(" and ");
  const count = homes(review.data.homes);
  const found = entries(review.data);
  return (
    <SettingsSection
      title="Home folders"
      description={`Every account gets a private home folder in ${container}. Sharing that folder, or a folder above it such as ${DriveRoot.label}, would give access to all ${count}.`}
    >
      <div className="flex items-start justify-between gap-4 px-4 py-5 sm:px-5">
        <div className="min-w-0 space-y-1">
          <FieldLabel htmlFor="allow-home-container-sharing">
            Allow sharing the home folders container
          </FieldLabel>
          <p
            id="allow-home-container-sharing-hint"
            className="max-w-prose text-pretty text-sm text-muted-foreground"
          >
            {allowed
              ? "On. Each new grant or link that reaches every home folder still asks for an extra confirmation."
              : "Off. Nobody, administrators included, can share it or a folder above it. Individual folders, including single home folders, can still be shared."}
          </p>
        </div>
        <Switch
          id="allow-home-container-sharing"
          className="mt-1"
          aria-describedby="allow-home-container-sharing-hint"
          checked={allowed}
          disabled={busy}
          onCheckedChange={(next) => {
            if (!next) {
              void run(
                () => save(false),
                found.length
                  ? "Turned off. The sharing listed below keeps working until you remove it."
                  : "Turned off.",
              );
              return;
            }
            onConfirm({
              title: "Allow sharing the home folders container?",
              description: `Anyone who manages sharing on ${container} or a folder above it, such as ${DriveRoot.label}, will be able to share it. One grant or public link there gives access to all ${count}, including files their owners never shared, and new accounts get no home folder while it exists. An upload link there lets anyone with it add files beside them, without opening them. Each share asks for an extra confirmation first. Nothing is shared now.`,
              confirmLabel: "Allow sharing",
              action: async () => {
                setError(null);
                setStatus(null);
                await save(true);
                setStatus("Turned on.");
              },
            });
          }}
        />
      </div>
      {(status || error) && (
        <p
          role={error ? "alert" : "status"}
          className={`px-4 pb-4 text-pretty text-sm sm:px-5 ${error ? "text-destructive" : "text-muted-foreground"}`}
        >
          {error ?? status}
        </p>
      )}
      {found.length > 0 && (
        <div className="space-y-3 border-t border-border/50 px-4 py-5 sm:px-5">
          <div className="space-y-1">
            <p className="text-sm font-medium">
              Sharing that reaches every home folder
            </p>
            <p className="max-w-prose text-pretty text-sm text-muted-foreground">
              {allowed
                ? "Each of these gives access to every home folder."
                : "Created while sharing was allowed. It still works until you remove it, and new accounts get no home folder while any grant or public link here exists."}
            </p>
          </div>
          <ul
            aria-label="Sharing that reaches every home folder"
            className="space-y-2"
          >
            {found.map((entry) => (
              <li
                key={`${entry.kind}:${entry.id}`}
                className="flex flex-wrap items-center justify-between gap-2"
              >
                <span className="min-w-0 break-words text-sm">
                  {entry.label}
                </span>
                <Button
                  variant="tertiary"
                  size="compact"
                  disabled={busy}
                  aria-label={`Remove: ${entry.label}`}
                  onClick={() =>
                    void run(async () => {
                      await remove(entry);
                      await queryClient.invalidateQueries({ queryKey });
                    }, "Removed. Everything else is unchanged.")
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          {found.length > 1 && (
            <Button
              variant="tertiary"
              size="compact"
              disabled={busy}
              onClick={() =>
                onConfirm({
                  title: `Remove all ${found.length} shares that reach every home folder?`,
                  description:
                    "The people, groups and links listed lose this access. Files, and sharing on individual folders, stay as they are.",
                  confirmLabel: "Remove all",
                  action: async () => {
                    for (const entry of found) await remove(entry);
                    await queryClient.invalidateQueries({ queryKey });
                  },
                })
              }
            >
              Remove all
            </Button>
          )}
        </div>
      )}
    </SettingsSection>
  );
}
