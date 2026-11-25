import { useState } from "react";
import { Clock, FolderOpen, Library, MonitorSmartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/alert-dialog";
import { queryClient, trpc, trpcClient } from "@/lib/trpc";
import { trpcErrorCode } from "@/lib/trpc-error";
import type { Library as LibraryRecord } from "@/server/libraries/libraries";
import type { PairedDeviceListing } from "@/server/libraries/paired-devices";
import type { WaitingPairing } from "@/server/libraries/device-pairing";
import { lazyComponent } from "@/components/lazy-component";
import { SettingsSection } from "../settings-section";

// Loads when a library is created or edited, with its folder chooser.
const LibraryEditor = lazyComponent(async () => ({
  default: (await import("./library-editor")).LibraryEditor,
}));

export type LibrariesSettingsState = {
  pairing: { kind: "available" } | { kind: "unavailable"; reason: string };
  libraries: LibraryRecord[];
  devices: PairedDeviceListing[];
  /** Approvals whose device has not collected its sign-in yet. */
  waiting: WaitingPairing[];
};

type Editing = { kind: "new" } | { kind: "edit"; library: LibraryRecord };
type Confirming =
  | { kind: "delete"; library: LibraryRecord }
  | { kind: "disconnect"; device: PairedDeviceListing }
  | { kind: "cancel"; pairing: WaitingPairing };

const formatDate = (milliseconds: number) =>
  new Date(milliseconds).toLocaleDateString(undefined, { dateStyle: "medium" });

const count = (value: number, one: string, many: string) =>
  `${value} ${value === 1 ? one : many}`;

/** What a failed confirmation leaves as it was, said plainly. */
function stillThere(action: Confirming) {
  switch (action.kind) {
    case "delete":
      return "Nimbus could not delete the library, so it and its paired devices are unchanged. Check your connection and try again.";
    case "cancel":
      return "Nimbus could not cancel the pairing, so the approval still stands. Check your connection and try again.";
    case "disconnect":
      return "Nimbus could not disconnect the device, so it is still connected. Check your connection and try again.";
  }
}

const refresh = () =>
  queryClient.invalidateQueries(trpc.libraries.settings.queryFilter());

export function LibrariesSettings({
  state,
}: {
  state: LibrariesSettingsState;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async (action: Confirming) => {
    setBusy(true);
    setError(null);
    try {
      if (action.kind === "delete")
        await trpcClient.libraries.deleteLibrary.mutate({
          id: action.library.id,
        });
      else if (action.kind === "cancel")
        await trpcClient.libraries.cancelPairing.mutate({
          id: action.pairing.id,
        });
      else
        await trpcClient.libraries.revokeDevice.mutate({
          id: action.device.id,
        });
      // The dialog closes, and the row goes, only once the server confirmed and the list is
      // read again: the page never shows a device gone that may still be connected.
      await refresh();
      setConfirming(null);
    } catch (failure) {
      // A refusal the server explains (such as "already disconnected") is shown as it is;
      // anything else means nothing is known to have changed.
      setError(
        trpcErrorCode(failure) !== undefined && failure instanceof Error
          ? failure.message
          : stillThere(action),
      );
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-balance text-2xl font-semibold">Libraries</h1>
        <p className="max-w-prose text-pretty text-sm text-muted-foreground">
          A library is a set of folders you offer, read-only, to apps and
          devices you pair with it. A paired device sees only its library, never
          the rest of your files, and cannot change anything.
        </p>
      </div>
      {state.pairing.kind === "unavailable" && (
        <p
          role="note"
          className="max-w-prose text-pretty text-sm text-muted-foreground"
        >
          {state.pairing.reason}
        </p>
      )}
      <SettingsSection
        title="Your libraries"
        description="Each includes everything in its folders and their subfolders, including files added later."
        action={
          <Button size="compact" onClick={() => setEditing({ kind: "new" })}>
            New library
          </Button>
        }
      >
        {state.libraries.length === 0 ? (
          <div className="flex items-start gap-4 p-5 sm:py-8">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-background">
              <Library
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">No libraries yet</p>
              <p className="max-w-prose text-pretty text-sm text-muted-foreground">
                Create one to pair a device with it.
              </p>
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-border/50" aria-label="Libraries">
            {state.libraries.map((library) => (
              <li
                key={library.id}
                className="flex items-center gap-3 px-4 py-4 sm:px-5"
              >
                <FolderOpen
                  className="size-5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="truncate text-sm font-medium">
                    {library.title}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {library.folders.join(", ")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {count(
                      library.devices.length,
                      "paired device",
                      "paired devices",
                    )}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="compact"
                  onClick={() => setEditing({ kind: "edit", library })}
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="compact"
                  onClick={() => {
                    setError(null);
                    setConfirming({ kind: "delete", library });
                  }}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
      <SettingsSection
        title="Paired devices"
        description="Pair a device by opening the address it shows and entering its code. Disconnecting stops its access immediately."
      >
        {state.devices.length === 0 && state.waiting.length === 0 ? (
          <div className="flex items-start gap-4 p-5 sm:py-8">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-background">
              <MonitorSmartphone
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">No paired devices</p>
              <p className="max-w-prose text-pretty text-sm text-muted-foreground">
                Devices appear here after you approve their code.
              </p>
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-border/50" aria-label="Paired devices">
            {state.waiting.map((pairing) => (
              <li
                key={pairing.id}
                className="flex items-center gap-3 px-4 py-4 sm:px-5"
              >
                <Clock
                  className="size-5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="truncate text-sm font-medium">
                    <bdi>{pairing.deviceName}</bdi>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <bdi>{pairing.library.title}</bdi> · Waiting for the device
                    to finish pairing
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="compact"
                  onClick={() => {
                    setError(null);
                    setConfirming({ kind: "cancel", pairing });
                  }}
                >
                  Cancel
                </Button>
              </li>
            ))}
            {state.devices.map((device) => (
              <li
                key={device.id}
                className="flex items-center gap-3 px-4 py-4 sm:px-5"
              >
                <MonitorSmartphone
                  className="size-5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="truncate text-sm font-medium">
                    <bdi>{device.name}</bdi>
                  </p>
                  <p className="flex flex-wrap gap-x-1.5 text-xs text-muted-foreground">
                    <bdi className="min-w-0 truncate">
                      {device.library.title}
                    </bdi>
                    <span aria-hidden="true">·</span>
                    <span className="whitespace-nowrap">
                      Paired {formatDate(device.pairedAt)}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="whitespace-nowrap">
                      Last used {formatDate(device.lastUsedAt)}
                    </span>
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="compact"
                  onClick={() => {
                    setError(null);
                    setConfirming({ kind: "disconnect", device });
                  }}
                >
                  Disconnect
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
      {editing && (
        <LibraryEditor
          editing={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirming(null);
        }}
      >
        <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto [&>*]:min-w-0">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-balance">
              {confirming?.kind === "delete" ? (
                <>
                  Delete <bdi>{confirming.library.title}</bdi>?
                </>
              ) : confirming?.kind === "cancel" ? (
                <>
                  Cancel pairing <bdi>{confirming.pairing.deviceName}</bdi>?
                </>
              ) : (
                <>
                  Disconnect{" "}
                  <bdi>{confirming?.device.name ?? "this device"}</bdi>?
                </>
              )}
            </AlertDialogTitle>
            <AlertDialogDescription className="break-words text-pretty">
              {confirming?.kind === "delete"
                ? `${count(confirming.library.devices.length, "device paired with it is", "devices paired with it are")} disconnected. Its folders and files stay as they are.`
                : confirming?.kind === "cancel"
                  ? "Your approval is withdrawn before the device collects it, and the device gets no access. To use it, pair it again from the device."
                  : "It loses access immediately. To use it again, pair it again from the device."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-pretty text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              {confirming?.kind === "cancel" ? "Keep" : "Cancel"}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                if (confirming) void confirm(confirming);
              }}
            >
              {confirming?.kind === "delete"
                ? busy
                  ? "Deleting…"
                  : "Delete"
                : confirming?.kind === "cancel"
                  ? busy
                    ? "Cancelling…"
                    : "Cancel pairing"
                  : busy
                    ? "Disconnecting…"
                    : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
