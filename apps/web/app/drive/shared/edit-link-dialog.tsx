import { useState } from "react";
import type { ShareMode } from "@nimbus/api/drive-store";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldLabel } from "@/components/ui/field";
import { queryClient, trpcClient } from "@/lib/trpc";
import { LinkSettingsDraft, LinkSettingsFields } from "./link-settings";
import { DriveRoot } from "@nimbus/api/drive-root";

export type EditableLink = {
  id: string;
  path: string;
  expiresAt: number | null;
  maxDownloads: number | null;
  mode: ShareMode;
  passwordProtected: boolean;
};

type PasswordChoice = "keep" | "set" | "remove";
const passwordChoices: Record<PasswordChoice, string> = {
  keep: "Keep current password",
  set: "Change password",
  remove: "Remove password",
};

export default function EditLinkDialog({
  link,
  onClose,
}: {
  link: EditableLink;
  onClose: () => void;
}) {
  const [settings, setSettings] = useState(LinkSettingsDraft.from(link));
  const [choice, setChoice] = useState<PasswordChoice>(
    link.passwordProtected ? "keep" : "set",
  );
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passwordInput = choice === "set";
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await trpcClient.shares.update.mutate({
        id: link.id,
        ...LinkSettingsDraft.toSettings(settings),
        password:
          choice === "remove"
            ? { kind: "remove" }
            : choice === "set" && password
              ? { kind: "set", value: password }
              : { kind: "keep" },
      });
      await queryClient.invalidateQueries({ queryKey: ["shares"] });
      onClose();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The link settings could not be saved. Your previous settings still apply. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="min-w-0 break-words pr-6 text-balance">
            Edit link to {link.path || DriveRoot.label}
          </DialogTitle>
          <DialogDescription>
            Changes apply to the existing link address.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {link.passwordProtected && (
            <>
              <FieldLabel htmlFor="edit-link-password-choice">
                Password
              </FieldLabel>
              <Select
                items={passwordChoices}
                value={choice}
                onValueChange={(value) => {
                  if (value !== null) setChoice(value);
                }}
              >
                <SelectTrigger
                  id="edit-link-password-choice"
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(passwordChoices).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}
          {passwordInput && (
            <>
              <FieldLabel htmlFor="edit-link-password">
                {link.passwordProtected
                  ? "New password"
                  : "Password (optional)"}
              </FieldLabel>
              <Input
                id="edit-link-password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                maxLength={128}
                required={link.passwordProtected}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              {link.passwordProtected && (
                <p className="text-pretty text-xs text-muted-foreground">
                  Visitors who unlocked the link will need the new password.
                </p>
              )}
            </>
          )}
          <LinkSettingsFields
            id="edit-link"
            value={settings}
            onChange={setSettings}
          />
          {error && (
            <p role="alert" className="text-pretty text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="tertiary"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
