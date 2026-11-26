import { useQuery } from "@tanstack/react-query";
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
} from "@/components/ui/select";
import { FieldLabel } from "@/components/ui/field";
import { queryClient, trpcClient, trpc } from "@/lib/trpc";
import { LinkSettingsDraft, LinkSettingsFields } from "./link-settings";
import { BreadcrumbTrail } from "../files/breadcrumb-trail";

export type EditableLink = {
  id: string;
  path: string;
  expiresAt: number | null;
  maxDownloads: number | null;
  mode: ShareMode;
  passwordProtected: boolean;
};

type PasswordChoice = "keep" | "set" | "remove";
const isPasswordChoice = (value: string): value is PasswordChoice =>
  Object.hasOwn(passwordChoices, value);
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
  const top = useQuery(trpc.access.me.queryOptions()).data?.top ?? "";
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
  const unsavedInput =
    !LinkSettingsDraft.same(settings, LinkSettingsDraft.from(link)) ||
    choice !== (link.passwordProtected ? "keep" : "set") ||
    password !== "";
  return (
    <Dialog
      open
      unsavedInput={unsavedInput}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="min-w-0 break-words pr-6 text-balance">
            Edit link to {BreadcrumbTrail.name(link.path, top)}
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
                value={choice}
                onValueChange={(value) => {
                  if (isPasswordChoice(value)) setChoice(value);
                }}
              >
                <SelectTrigger
                  id="edit-link-password-choice"
                  className="w-full"
                />
                <SelectContent className="max-w-[var(--available-width)]">
                  {Object.entries(passwordChoices).map(
                    ([value, label], index) => (
                      <SelectItem index={index} key={value} value={value}>
                        {label}
                      </SelectItem>
                    ),
                  )}
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
