import { useState } from "react";
import { refreshAccount } from "@/lib/account-refresh";
import { Monitor, Smartphone } from "lucide-react";
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
} from "@/components/ui/alert-dialog";
import { securityClient } from "@/lib/security-client";
import { SettingsSection } from "../settings-section";

export type SessionSummary = {
  id: string;
  device: string;
  mobile: boolean;
  ip: string | null;
  lastActive: number;
  current: boolean;
};

type Pending = { kind: "one"; session: SessionSummary } | { kind: "others" };

export function SessionSettings({ sessions }: { sessions: SessionSummary[] }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = sessions.filter((session) => !session.current).length;
  return (
    <SettingsSection
      title="Sessions"
      description="Browsers signed in to your account. WebDAV app passwords are managed in Settings, WebDAV."
      action={
        others > 0 ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setError(null);
              setPending({ kind: "others" });
            }}
          >
            Sign out other sessions
          </Button>
        ) : undefined
      }
    >
      <ul aria-label="Sessions" className="divide-y divide-border/50">
        {sessions.map((session) => {
          const Icon = session.mobile ? Smartphone : Monitor;
          return (
            <li
              key={session.id}
              className="flex items-center gap-3 px-4 py-4 sm:px-5"
            >
              <Icon
                className="size-5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <p className="truncate text-sm font-medium">
                    {session.device}
                  </p>
                  {session.current && (
                    <span className="text-xs text-muted-foreground">
                      This browser
                    </span>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {session.ip && (
                    <span className="tabular-nums">{session.ip} · </span>
                  )}
                  {"Active "}
                  <time
                    className="tabular-nums"
                    dateTime={new Date(session.lastActive).toISOString()}
                    suppressHydrationWarning
                  >
                    {new Date(session.lastActive).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </time>
                </p>
              </div>
              {!session.current && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setError(null);
                    setPending({ kind: "one", session });
                  }}
                >
                  Sign out
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => !open && !busy && setPending(null)}
      >
        <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl [&>*]:min-w-0">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-balance">
              {pending?.kind === "others"
                ? "Sign out other sessions?"
                : "Sign out this session?"}
            </AlertDialogTitle>
            <AlertDialogDescription className="break-words text-pretty">
              {pending?.kind === "others"
                ? `${others === 1 ? "1 other browser" : `${others} other browsers`} will need to sign in again. This browser stays signed in and WebDAV app passwords keep working.`
                : `${pending?.session.device ?? "That browser"} will need to sign in again. Your files are not affected.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-pretty text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                const target = pending;
                if (!target) return;
                setBusy(true);
                setError(null);
                const request =
                  target.kind === "others"
                    ? securityClient.revokeOtherSessions()
                    : securityClient.nimbus.revokeSession({
                        id: target.session.id,
                      });
                void request
                  .then((result) => {
                    if (result.error) {
                      setError(
                        result.error.message ??
                          "The session could not be signed out. Try again.",
                      );
                      return;
                    }
                    setPending(null);
                    void refreshAccount();
                  })
                  .catch(() =>
                    setError(
                      "The server could not be reached. Nothing was changed. Try again.",
                    ),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? "Signing out…" : "Sign out"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}
