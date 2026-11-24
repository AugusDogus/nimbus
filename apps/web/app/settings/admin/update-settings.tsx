import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CodeLoad } from "@/lib/code-load";
import { queryClient } from "@/lib/trpc";
import {
  AdminConfirmationDialog,
  type AdminConfirmation,
} from "./admin-confirmation-dialog";
import {
  errorAnswer,
  panelAnswer,
  updateEvent,
  type UpdatePanel,
} from "./update-panel";
import { SettingsRow, SettingsSection } from "../settings-section";

const queryKey = ["updates"];
const endpoint = "/api/admin/updates";

async function readPanel(response: Response) {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = errorAnswer.safeParse(body);
    throw new Error(
      error.success
        ? error.data.error
        : "Nimbus could not read its update status. Reload the page to try again.",
    );
  }
  return panelAnswer.parse(body).panel;
}

const post = (body: object) =>
  fetch(endpoint, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** What an install or rollback under way is doing, from the supervisor's stream. */
type Progressing = {
  kind: "install" | "rollback";
  stage: string;
  seconds: number;
  readyTimeoutSeconds: number;
};

/** How the last action on this page ended. */
type Finished =
  | { ok: true; kind: "install" | "rollback"; to: string }
  | { ok: false; message: string };

const stages: Record<string, string> = {
  preparing: "Downloading and verifying the release",
  "handing-over": "Starting the new version beside the running one",
  "full-restart": "Restarting Nimbus for its database changes",
  restarting: "Starting Nimbus again",
  starting: "Starting Nimbus",
};

const build = (sequence: number | null, commit: string | null) =>
  sequence === null
    ? "a build without a number"
    : `build ${sequence}${commit ? ` (${commit.slice(0, 7)})` : ""}`;

const time = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

const hours = Array.from({ length: 24 }, (_, hour) => ({
  value: String(hour),
  label: `${String(hour).padStart(2, "0")}:00`,
}));

const modes = [
  { value: "off", label: "Off" },
  { value: "notify", label: "Notify only" },
  { value: "install", label: "Install at a quiet hour" },
] as const;

const modeDescriptions: Record<UpdatePanel["schedule"]["mode"], string> = {
  off: "Nimbus looks for updates only when you check.",
  notify:
    "Nimbus checks twice a day and shows here what is available; it installs nothing on its own.",
  install:
    "Nimbus checks twice a day, and at the hour you choose checks again and installs what is available.",
};

export function UpdateSettings() {
  const panel = useQuery({
    queryKey,
    queryFn: async () =>
      readPanel(await fetch(endpoint, { cache: "no-store" })),
    // While something runs, as it is reported by the supervisor; otherwise once a minute.
    refetchInterval: (query) => (query.state.data?.operation ? 2_000 : 60_000),
  });
  const [progressing, setProgressing] = useState<Progressing | null>(null);
  const [finished, setFinished] = useState<Finished | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<AdminConfirmation | null>(
    null,
  );

  const refresh = (next?: UpdatePanel) =>
    next
      ? queryClient.setQueryData(queryKey, next)
      : queryClient.invalidateQueries({ queryKey });

  const ask = async (body: object) => {
    setBusy(true);
    setError(null);
    try {
      refresh(await readPanel(await post(body)));
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The request failed. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  /** Install or roll back, following the supervisor's stream to its end. */
  const act = async (kind: "install" | "rollback") => {
    setError(null);
    setFinished(null);
    setProgressing({
      kind,
      stage: "preparing",
      seconds: 0,
      readyTimeoutSeconds: panel.data?.operation?.readyTimeoutSeconds ?? 300,
    });
    try {
      const response = await post({ action: kind });
      if (!response.ok || !response.body) {
        const body: unknown = await response.json().catch(() => null);
        const parsed = errorAnswer.safeParse(body);
        setFinished({
          ok: false,
          message: parsed.success
            ? parsed.data.error
            : "The request was refused. Reload the page and try again.",
        });
        return;
      }
      const decoder = new TextDecoder();
      let buffered = "";
      for await (const chunk of response.body) {
        buffered += decoder.decode(chunk, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            continue;
          }
          const event = updateEvent.safeParse(value);
          if (!event.success) continue;
          const read = event.data;
          if (read.kind === "started")
            setProgressing(
              (now) =>
                now && {
                  ...now,
                  readyTimeoutSeconds: read.readyTimeoutSeconds,
                },
            );
          else if (read.kind === "progress")
            setProgressing(
              (now) =>
                now && { ...now, stage: read.phase, seconds: read.seconds },
            );
          else {
            if (read.ok) {
              // The server runs another build now: the next move to another page loads it.
              if (kind === "install") CodeLoad.serverUpdated();
              setFinished({ ok: true, kind, to: read.report?.to ?? "" });
            } else
              setFinished({
                ok: false,
                message:
                  read.error?.message ??
                  "The update did not happen. Nothing was changed.",
              });
          }
        }
      }
    } catch {
      // The connection ended with the server that answered, as a handover can end it; the
      // supervisor's own status says how it went.
    } finally {
      setProgressing(null);
      // Whether the stream reached its end or the handover cut it, the supervisor says the rest.
      await refresh();
    }
  };

  const data = panel.data;
  const operation = progressing ?? data?.operation ?? null;
  const off =
    data?.unavailable ??
    (data?.source.kind === "off" ? data.source.reason : null);
  const canRollBack =
    !off &&
    data &&
    (data.previous !== null || data.running.name !== "built-in");
  const rollBackTo = data?.previous ?? "the image's own release";

  return (
    <SettingsSection
      title="Updates"
      description="Nimbus updates itself from signed releases of its channel, without closing open connections: films keep playing and transfers keep going while the new version takes over."
      action={
        data && !off && !operation ? (
          <Button
            size="compact"
            variant="tertiary"
            disabled={busy}
            loading={busy}
            onClick={() => void ask({ action: "check" })}
          >
            Check now
          </Button>
        ) : undefined
      }
    >
      {panel.isPending ? (
        <p className="px-4 py-4 text-sm sm:px-5">Loading update status…</p>
      ) : panel.error ? (
        <p
          role="alert"
          className="px-4 py-4 text-pretty text-sm text-muted-foreground sm:px-5"
        >
          {panel.error.message}
        </p>
      ) : data ? (
        <>
          <SettingsRow
            label="Running"
            description={
              data.running.name === "built-in"
                ? "The release this container image was built with."
                : `Installed from the ${data.channel ?? "update"} channel.`
            }
          >
            <p className="text-sm font-medium tabular-nums sm:text-right">
              {build(data.running.sequence, data.running.commit)}
              {data.channel ? ` · ${data.channel}` : ""}
            </p>
          </SettingsRow>

          {off ? (
            <div className="space-y-1 px-4 py-4 sm:px-5" role="status">
              <p className="text-sm font-medium">Updates are off</p>
              <p className="max-w-prose text-pretty text-sm text-muted-foreground">
                {off}
              </p>
            </div>
          ) : operation ? (
            <OperationProgress operation={operation} />
          ) : (
            <Status
              data={data}
              finished={finished}
              busy={busy}
              onInstall={() => void act("install")}
            />
          )}

          {error && (
            <p
              role="alert"
              className="px-4 py-3 text-pretty text-sm text-destructive sm:px-5"
            >
              {error}
            </p>
          )}

          {canRollBack && !operation && (
            <SettingsRow
              label="Roll back"
              description={`Go back to ${rollBackTo}, which ran before. It is checked again before it starts, and serves without closing connections.`}
            >
              <div className="sm:flex sm:justify-end">
                <Button
                  size="compact"
                  variant="ghost"
                  onClick={() =>
                    setConfirmation({
                      title: "Roll back Nimbus?",
                      description: `Nimbus goes back to ${rollBackTo}. Connections stay open while it takes over; you can update again afterwards.`,
                      confirmLabel: "Roll back",
                      action: () => act("rollback"),
                    })
                  }
                >
                  Roll back
                </Button>
              </div>
            </SettingsRow>
          )}

          <SettingsRow
            label="Automatic updates"
            description={`${modeDescriptions[data.schedule.mode]}${data.schedule.mode === "install" ? ` Hours are in the server's time zone (${data.timeZone}).` : ""}`}
          >
            <div className="flex flex-wrap gap-2 sm:justify-end">
              <Select
                items={modes}
                value={data.schedule.mode}
                onValueChange={(mode) => {
                  const chosen = modes.find((one) => one.value === mode);
                  if (chosen)
                    void ask({
                      action: "schedule",
                      mode: chosen.value,
                      hour: data.schedule.hour,
                    });
                }}
                disabled={busy || Boolean(off)}
              >
                <SelectTrigger
                  aria-label="Automatic updates"
                  className="w-full sm:w-56"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {modes.map((mode) => (
                    <SelectItem key={mode.value} value={mode.value}>
                      {mode.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {data.schedule.mode === "install" && (
                <Select
                  items={hours}
                  value={String(data.schedule.hour)}
                  onValueChange={(hour) =>
                    void ask({
                      action: "schedule",
                      mode: "install",
                      hour: Number(hour),
                    })
                  }
                  disabled={busy || Boolean(off)}
                >
                  <SelectTrigger aria-label="Quiet hour" className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {hours.map((hour) => (
                      <SelectItem key={hour.value} value={hour.value}>
                        {hour.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </SettingsRow>
        </>
      ) : null}
      {confirmation && (
        <AdminConfirmationDialog
          confirmation={confirmation}
          onClose={() => setConfirmation(null)}
        />
      )}
    </SettingsSection>
  );
}

function OperationProgress({ operation }: { operation: Progressing }) {
  // Getting ready has a limit, the supervisor's readiness timeout; preparing has none to show.
  const timed = operation.stage !== "preparing";
  const value = timed
    ? Math.min(
        95,
        Math.round((operation.seconds / operation.readyTimeoutSeconds) * 100),
      )
    : null;
  return (
    <div
      className="space-y-3 px-4 py-4 sm:px-5"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">
          {operation.kind === "install" ? "Updating Nimbus" : "Rolling back"}
        </p>
        <p className="text-xs tabular-nums text-muted-foreground">
          {operation.seconds} s
          {timed ? ` of at most ${operation.readyTimeoutSeconds} s` : ""}
        </p>
      </div>
      <Progress
        value={value}
        aria-label={stages[operation.stage] ?? operation.stage}
      />
      <p className="text-pretty text-sm text-muted-foreground">
        {stages[operation.stage] ?? operation.stage}. The running version keeps
        serving until the new one is ready; this page loads the new version when
        you next move to another page.
      </p>
    </div>
  );
}

function Status({
  data,
  finished,
  busy,
  onInstall,
}: {
  data: UpdatePanel;
  finished: Finished | null;
  busy: boolean;
  onInstall: () => void;
}) {
  const outcome: Finished | null =
    finished ??
    (data.lastOutcome
      ? data.lastOutcome.ok
        ? {
            ok: true,
            kind: data.lastOutcome.kind,
            to: data.lastOutcome.release,
          }
        : { ok: false, message: data.lastOutcome.message }
      : null);
  const available = data.available;
  return (
    <div className="space-y-4 px-4 py-4 sm:px-5">
      {outcome &&
        (outcome.ok ? (
          <div className="space-y-2" role="status">
            <p className="text-sm font-medium">
              {outcome.kind === "install" ? "Updated" : "Rolled back"} to{" "}
              {build(data.running.sequence, data.running.commit)}
            </p>
            <p className="text-pretty text-sm text-muted-foreground">
              It serves now. Pages load the new version as you move between
              them, or now:
            </p>
            <Button
              size="compact"
              variant="secondary"
              onClick={() => location.reload()}
            >
              Load the new version
            </Button>
          </div>
        ) : (
          <div className="space-y-1" role="alert">
            <p className="text-sm font-medium text-destructive">
              The last update did not happen
            </p>
            <p className="max-w-prose text-pretty text-sm text-muted-foreground">
              {outcome.message}
            </p>
          </div>
        ))}
      {available?.kind === "offer" ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium">
                {build(available.build.sequence, available.build.commit)} is
                available
              </p>
              <p className="text-xs text-muted-foreground">
                Published {time(available.build.publishedAt)}
              </p>
            </div>
            <Button size="compact" disabled={busy} onClick={onInstall}>
              Update now
            </Button>
          </div>
          {available.notes.length > 0 && (
            <ul
              aria-label="Changes in this update"
              className="space-y-1 border-l border-border/60 pl-3"
            >
              {available.notes.slice(0, 8).map((note) => (
                <li
                  key={note.commit}
                  className="text-pretty text-sm text-muted-foreground"
                >
                  {note.subject}
                </li>
              ))}
              {available.notes.length > 8 && (
                <li className="text-sm text-muted-foreground">
                  and {available.notes.length - 8} more
                </li>
              )}
            </ul>
          )}
        </div>
      ) : available?.kind === "needs-newer-image" ? (
        <div className="space-y-1" role="status">
          <p className="text-sm font-medium">
            {build(available.build.sequence, available.build.commit)} needs a
            newer image
          </p>
          <p className="max-w-prose text-pretty text-sm text-muted-foreground">
            {available.message}
          </p>
        </div>
      ) : (
        !outcome?.ok && (
          <div className="space-y-1">
            <p className="text-sm font-medium">Nimbus is up to date</p>
            <p className="text-pretty text-sm text-muted-foreground">
              {data.lastCheck
                ? `Last checked ${time(data.lastCheck.at)}.`
                : "Not checked yet."}
            </p>
          </div>
        )
      )}
    </div>
  );
}
