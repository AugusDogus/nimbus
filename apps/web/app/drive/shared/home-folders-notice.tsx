import { useQuery } from "@tanstack/react-query";
import { TriangleAlertIcon } from "lucide-react";
import type {
  HomesExposure,
  SharingKind,
} from "@nimbus/api/home-container-sharing";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { trpcClient } from "@/lib/trpc";

/**
 * Whether sharing `path` would reach every home folder. Loaded with the sharing dialogs, which
 * open on demand, so pages pay for none of this until someone shares.
 */
export function useHomesExposure(path: string): HomesExposure | undefined {
  const query = useQuery({
    queryKey: ["home-folders-exposure", path],
    queryFn: () => trpcClient.access.homeFoldersExposure.query({ path }),
  });
  // The server checks every share again, so a failed lookup only skips the early notice.
  return query.isError ? { kind: "none" } : query.data;
}

/** Whether a sharing form may submit, and what to send with it. */
export const HomesExposureGate = {
  blocked: (exposure: HomesExposure | undefined, acknowledged: boolean) =>
    exposure === undefined ||
    exposure.kind === "refused" ||
    (exposure.kind === "warn" && !acknowledged),
  input: (exposure: HomesExposure | undefined, acknowledged: boolean) =>
    exposure?.kind === "warn" && acknowledged
      ? { acknowledgeAllHomeFolders: true }
      : {},
} as const;

const homes = (count: number) =>
  `${count} ${count === 1 ? "home folder" : "home folders"}`;

const consequence: Record<SharingKind, (count: string) => string> = {
  grant: (count) =>
    `The person or group you choose will be able to open all ${count}, including files their owners never shared.`,
  link: (count) =>
    `Anyone with the link will be able to open all ${count}, including files their owners never shared.`,
  uploadLink: (count) =>
    `Anyone with the link will be able to add files to the folder that holds all ${count}.`,
};

function where(
  name: string,
  exposure: { container: string; relation: "is" | "above" },
) {
  return exposure.relation === "is"
    ? `${name} holds every user's home folder.`
    : `${name} contains "${exposure.container}", which holds every user's home folder.`;
}

/**
 * Explains, before anything is shared, that `name` covers every home folder: refused while the
 * setting is off, or allowed only after the person ticks an explicit confirmation. `id` must be
 * unique in the dialog; point the form's submit button at it with `aria-describedby`.
 */
export function HomeFoldersNotice({
  id,
  name,
  sharing,
  exposure,
  acknowledged,
  onAcknowledgedChange,
}: {
  id: string;
  name: string;
  sharing: SharingKind;
  exposure: HomesExposure | undefined;
  acknowledged: boolean;
  onAcknowledgedChange: (acknowledged: boolean) => void;
}) {
  if (exposure === undefined || exposure.kind === "none") return null;
  const count = homes(exposure.homes);
  if (exposure.kind === "refused")
    return (
      <div
        id={id}
        className="space-y-1 rounded-lg border border-border bg-muted/50 p-3 text-sm"
      >
        <p className="font-medium">Sharing this folder is turned off</p>
        <p className="text-pretty text-muted-foreground">
          {where(name, exposure)} Sharing it would expose all {count}, so
          nothing can be shared here. Share individual folders instead, or ask a
          server administrator to turn on &ldquo;Allow sharing the home folders
          container&rdquo; in Settings, Administration.
        </p>
      </div>
    );
  return (
    <div
      id={id}
      className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
    >
      <div className="flex gap-2">
        <TriangleAlertIcon
          className="mt-0.5 size-4 shrink-0 text-destructive"
          aria-hidden="true"
        />
        <div className="space-y-1">
          <p className="font-medium">This gives access to every home folder</p>
          <p className="text-pretty text-muted-foreground">
            {where(name, exposure)} {consequence[sharing](count)} New accounts
            get no home folder while this sharing exists. Nothing is shared
            until you confirm.
          </p>
        </div>
      </div>
      <div className="flex items-start gap-2">
        <Checkbox
          id={`${id}-confirm`}
          className="mt-0.5"
          checked={acknowledged}
          onCheckedChange={(checked) => onAcknowledgedChange(checked)}
        />
        <Label htmlFor={`${id}-confirm`} className="text-pretty font-normal">
          I understand this exposes all {count}
        </Label>
      </div>
    </div>
  );
}
