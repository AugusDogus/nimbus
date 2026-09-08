"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsRow, SettingsSection } from "../settings-section";

export function PasswordSettings() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    kind: "error" | "success";
    text: string;
  } | null>(null);
  return (
    <SettingsSection
      title="Password"
      description="Choose a strong password you don’t use elsewhere."
    >
      <form
        className="divide-y divide-border/50"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const values = new FormData(form);
          const currentPassword = values.get("currentPassword");
          const newPassword = values.get("newPassword");
          const confirmPassword = values.get("confirmPassword");
          if (
            typeof currentPassword !== "string" ||
            typeof newPassword !== "string"
          )
            return;
          if (newPassword !== confirmPassword) {
            setMessage({
              kind: "error",
              text: "The new passwords do not match.",
            });
            return;
          }
          setBusy(true);
          setMessage(null);
          try {
            const result = await authClient.changePassword({
              currentPassword,
              newPassword,
              revokeOtherSessions: true,
            });
            if (result.error) {
              setMessage({
                kind: "error",
                text:
                  result.error.message ??
                  "Your password could not be changed. Check your current password and try again.",
              });
              return;
            }
            form.reset();
            setMessage({
              kind: "success",
              text: "Password changed. Other browser sessions have been signed out. Existing app passwords remain active.",
            });
          } catch {
            setMessage({
              kind: "error",
              text: "The server could not be reached. Try again before signing out.",
            });
          } finally {
            setBusy(false);
          }
        }}
      >
        <SettingsRow
          label={<Label htmlFor="current-password">Current password</Label>}
        >
          <Input
            id="current-password"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
            disabled={busy}
            className="bg-background"
          />
        </SettingsRow>
        <SettingsRow
          label={<Label htmlFor="new-password">New password</Label>}
          description="Use at least 8 characters."
        >
          <Input
            id="new-password"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            minLength={8}
            maxLength={128}
            required
            disabled={busy}
            className="bg-background"
          />
        </SettingsRow>
        <SettingsRow
          label={
            <Label htmlFor="confirm-new-password">Confirm new password</Label>
          }
        >
          <Input
            id="confirm-new-password"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            minLength={8}
            maxLength={128}
            required
            disabled={busy}
            className="bg-background"
          />
        </SettingsRow>
        <div className="space-y-3 px-4 py-4 sm:px-5">
          {message && (
            <p
              role={message.kind === "error" ? "alert" : "status"}
              className={
                message.kind === "error"
                  ? "text-pretty text-sm text-destructive"
                  : "text-pretty text-sm text-muted-foreground"
              }
            >
              {message.text}
            </p>
          )}
          <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
            <p className="max-w-prose text-pretty text-xs leading-relaxed text-muted-foreground">
              Changing your password signs out other browser sessions. WebDAV
              app passwords stay active.
            </p>
            <Button className="shrink-0" disabled={busy}>
              {busy ? "Saving…" : "Change password"}
            </Button>
          </div>
        </div>
      </form>
    </SettingsSection>
  );
}
