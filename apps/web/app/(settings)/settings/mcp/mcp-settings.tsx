"use client";

import { useState } from "react";
import { Bot, PlugZap } from "lucide-react";
import type { McpScope } from "@nimbus/api/mcp-scope";
import type { McpConnection } from "@/server/mcp/oauth/connections";
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
import { SettingsRow, SettingsSection } from "../settings-section";
import { CopyField } from "../webdav/copy-field";

export type McpSettingsState =
  | { kind: "enabled"; serverUrl: string; connections: McpConnection[] }
  | { kind: "unavailable" };

const scopeLabels: Record<McpScope, string> = {
  "files:read": "View",
  "files:write": "Edit",
  "files:share": "Share",
};

const formatDate = (milliseconds: number) =>
  new Date(milliseconds).toLocaleDateString(undefined, { dateStyle: "medium" });

function Timestamp({ prefix, value }: { prefix: string; value: number }) {
  return (
    <>
      {prefix}{" "}
      <time className="tabular-nums" dateTime={new Date(value).toISOString()}>
        {formatDate(value)}
      </time>
    </>
  );
}

export function McpSettings({ state }: { state: McpSettingsState }) {
  const [connections, setConnections] = useState(
    state.kind === "enabled" ? state.connections : [],
  );
  const [revoking, setRevoking] = useState<McpConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const revoke = async (connection: McpConnection) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/mcp/connections/${encodeURIComponent(connection.id)}`,
        { method: "DELETE" },
      );
      if (!response.ok && response.status !== 404) {
        const body: unknown = await response.json().catch(() => null);
        setError(
          typeof body === "object" &&
            body !== null &&
            "error" in body &&
            typeof body.error === "string"
            ? body.error
            : "The app could not be disconnected. It is still connected; try again.",
        );
        return;
      }
      setConnections((current) =>
        current.filter((entry) => entry.id !== connection.id),
      );
      setRevoking(null);
    } catch {
      setError(
        "Nimbus could not be reached. The app is still connected; check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-balance text-2xl font-semibold">MCP</h1>
        <p className="max-w-prose text-pretty text-sm text-muted-foreground">
          Let AI assistants such as Claude, ChatGPT, or Cursor work with your
          files. They act as you, with no more access than your account has.
        </p>
      </div>
      {state.kind === "unavailable" ? (
        <SettingsSection title="Connection">
          <div className="flex items-start gap-4 p-5 sm:py-8">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-background">
              <PlugZap
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">
                MCP is turned off on this server
              </p>
              <p className="max-w-prose text-pretty text-sm text-muted-foreground">
                Ask your server administrator to enable it. Apps you connected
                before stay listed and work again once it is on.
              </p>
            </div>
          </div>
        </SettingsSection>
      ) : (
        <>
          <SettingsSection
            title="Connection"
            description="Add Nimbus to your AI client as a remote MCP server."
          >
            <SettingsRow
              label="Server address"
              description="Your client opens Nimbus in a browser to approve access."
            >
              <CopyField label="Server address" value={state.serverUrl} />
            </SettingsRow>
            <SettingsRow
              label="Claude Code"
              description="Run this, then type /mcp in Claude Code to sign in."
            >
              <CopyField
                label="Claude Code command"
                value={`claude mcp add --transport http nimbus ${state.serverUrl}`}
              />
            </SettingsRow>
            <SettingsRow
              label="Other clients"
              description="Codex, Cursor, ChatGPT, and others."
            >
              <p className="text-pretty text-sm text-muted-foreground">
                Add a remote (Streamable HTTP) MCP server with the address
                above. No API key is needed.
              </p>
            </SettingsRow>
          </SettingsSection>
          <SettingsSection
            title="Connected apps"
            description="Disconnecting an app stops its access immediately. Your files remain intact."
          >
            {connections.length === 0 ? (
              <div className="flex items-start gap-4 p-5 sm:py-8">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-background">
                  <Bot
                    className="size-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium">No connected apps yet</p>
                  <p className="max-w-prose text-pretty text-sm text-muted-foreground">
                    Apps appear here after you approve them. You can disconnect
                    them at any time.
                  </p>
                </div>
              </div>
            ) : (
              <ul
                className="divide-y divide-border/50"
                aria-label="Connected apps"
              >
                {connections.map((connection) => (
                  <li
                    key={connection.id}
                    className="flex items-center gap-3 px-4 py-4 sm:px-5"
                  >
                    <Bot
                      className="size-5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <p className="truncate text-sm font-medium">
                          {connection.clientName}
                        </p>
                        <ul
                          className="flex flex-wrap gap-1"
                          aria-label={`Permissions for ${connection.clientName}`}
                        >
                          {connection.scopes.map((scope) => (
                            <li
                              key={scope}
                              className="rounded-md border border-border/60 px-1.5 py-px text-xs text-muted-foreground"
                            >
                              {scopeLabels[scope]}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        <Timestamp
                          prefix="Connected"
                          value={connection.connectedAt}
                        />
                        {" · "}
                        {connection.lastUsedAt === null ? (
                          "Not used yet"
                        ) : (
                          <Timestamp
                            prefix="Last used"
                            value={connection.lastUsedAt}
                          />
                        )}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setError(null);
                        setRevoking(connection);
                      }}
                    >
                      Disconnect
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </SettingsSection>
        </>
      )}
      <AlertDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRevoking(null);
        }}
      >
        <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl [&>*]:min-w-0">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-balance">
              Disconnect {revoking?.clientName}?
            </AlertDialogTitle>
            <AlertDialogDescription className="break-words text-pretty">
              It will lose access to your files immediately. Your files remain
              intact. To use it again, connect it from the app.
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
                if (revoking) void revoke(revoking);
              }}
            >
              {busy ? "Disconnecting…" : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
