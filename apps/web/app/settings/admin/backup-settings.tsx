import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as z from "zod/mini";
import { Button } from "@/components/ui/button";
import { ByteSize } from "@/lib/byte-size";
import { queryClient } from "@/lib/trpc";
import { SettingsSection } from "../settings-section";

const backupSchema = z.object({
  name: z.string(),
  size: z.number(),
  createdAt: z.number(),
});
const listSchema = z.object({ backups: z.array(backupSchema) });
const errorSchema = z.object({ error: z.string() });

async function request<T>(init: RequestInit, schema: z.ZodMiniType<T>) {
  const response = await fetch("/api/backups", { ...init, cache: "no-store" });
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = errorSchema.safeParse(body);
    throw new Error(
      error.success
        ? error.data.error
        : "The backup request failed. Try again.",
    );
  }
  return schema.parse(body);
}

export function BackupSettings() {
  const list = useQuery({
    queryKey: ["backups"],
    queryFn: () => request({}, listSchema),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backUp = async () => {
    setBusy(true);
    setError(null);
    try {
      await request({ method: "POST" }, z.object({ backup: backupSchema }));
      await queryClient.invalidateQueries({ queryKey: ["backups"] });
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The backup failed. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection
      title="Database backups"
      description="Nimbus copies its database every day while it runs. Files are not included; back up the data root separately."
      action={
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void backUp()}
        >
          {busy ? "Backing up…" : "Back up now"}
        </Button>
      }
    >
      {(error || list.error) && (
        <p
          role="alert"
          className="px-4 py-4 text-pretty text-sm text-destructive sm:px-5"
        >
          {error ?? list.error?.message}
        </p>
      )}
      {list.isPending ? (
        <p className="px-4 py-4 text-sm sm:px-5">Loading backups…</p>
      ) : list.data?.backups.length === 0 ? (
        <p className="px-4 py-4 text-pretty text-sm text-muted-foreground sm:px-5">
          No backups yet. The first one is made within an hour of startup.
        </p>
      ) : (
        <ul aria-label="Backups">
          {list.data?.backups.map((backup) => (
            <li
              key={backup.name}
              className="flex flex-wrap items-center gap-3 border-b border-border/50 px-4 py-3 last:border-b-0 sm:px-5"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium tabular-nums">
                  {new Date(backup.createdAt).toLocaleString()}
                </p>
                <p className="text-xs tabular-nums text-muted-foreground">
                  {ByteSize.format(backup.size)}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                render={
                  <a
                    href={`/api/backups/${encodeURIComponent(backup.name)}`}
                    download
                  />
                }
              >
                Download
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}
