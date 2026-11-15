"use client";

import type { ShareMode } from "@nimbus/api/drive-store";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Form state for the settings shared by creating and editing a public link. */
export type LinkSettingsDraft = {
  expiry: string;
  maxDownloads: string;
  mode: ShareMode;
};

const localInput = (timestamp: number) =>
  new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);

export const LinkSettingsDraft = {
  empty: { expiry: "", maxDownloads: "", mode: "download" } satisfies LinkSettingsDraft,
  from(share: {
    expiresAt: number | null;
    maxDownloads: number | null;
    mode: ShareMode;
  }): LinkSettingsDraft {
    return {
      expiry: share.expiresAt === null ? "" : localInput(share.expiresAt),
      maxDownloads: share.maxDownloads === null ? "" : String(share.maxDownloads),
      mode: share.mode,
    };
  },
  toSettings(draft: LinkSettingsDraft) {
    return {
      expiresAt: draft.expiry ? new Date(draft.expiry).getTime() : null,
      maxDownloads: draft.maxDownloads ? Number(draft.maxDownloads) : null,
      mode: draft.mode,
    };
  },
} as const;

export function LinkSettingsFields({
  id,
  value,
  onChange,
}: {
  id: string;
  value: LinkSettingsDraft;
  onChange: (value: LinkSettingsDraft) => void;
}) {
  return (
    <>
      <Label htmlFor={`${id}-expiry`}>Expires (optional)</Label>
      <Input
        id={`${id}-expiry`}
        type="datetime-local"
        value={value.expiry}
        onChange={(event) => onChange({ ...value, expiry: event.target.value })}
      />
      <Label htmlFor={`${id}-limit`}>Download limit (optional)</Label>
      <Input
        id={`${id}-limit`}
        type="number"
        inputMode="numeric"
        min={1}
        max={1_000_000}
        step={1}
        aria-describedby={`${id}-limit-hint`}
        value={value.maxDownloads}
        onChange={(event) =>
          onChange({ ...value, maxDownloads: event.target.value })
        }
      />
      <p id={`${id}-limit-hint`} className="text-pretty text-xs text-muted-foreground">
        The link stops working after this many downloads. Opening a preview counts as one.
      </p>
      <div className="flex items-start gap-2">
        <Checkbox
          id={`${id}-view-only`}
          className="mt-0.5"
          aria-describedby={`${id}-view-only-hint`}
          checked={value.mode === "view"}
          onCheckedChange={(checked) =>
            onChange({ ...value, mode: checked === true ? "view" : "download" })
          }
        />
        <div className="space-y-1">
          <Label htmlFor={`${id}-view-only`}>Preview only</Label>
          <p id={`${id}-view-only-hint`} className="text-pretty text-xs text-muted-foreground">
            Hides downloads and ZIPs, and blocks files that cannot be previewed. Visitors can still save anything their browser shows.
          </p>
        </div>
      </div>
    </>
  );
}
