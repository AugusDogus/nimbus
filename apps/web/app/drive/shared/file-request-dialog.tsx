import { useState, type ChangeEvent } from "react";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ByteSize } from "@/lib/byte-size";
import { queryClient, trpcClient } from "@/lib/trpc";
import { localDateTimeInput } from "./link-settings";

export type EditableFileRequest = {
  id: string;
  path: string;
  expiresAt: number | null;
  note: string | null;
  maxFileBytes: number | null;
  maxFiles: number | null;
  maxTotalBytes: number | null;
  passwordProtected: boolean;
};

export type FileRequestDialogMode =
  | { kind: "create"; folder: { name: string; path: string } }
  | { kind: "edit"; request: EditableFileRequest };

type Draft = {
  expiry: string;
  note: string;
  maxFileMegabytes: string;
  maxFiles: string;
  maxTotalMegabytes: string;
};

const draftFor = (mode: FileRequestDialogMode): Draft =>
  mode.kind === "create"
    ? {
        expiry: "",
        note: "",
        maxFileMegabytes: "",
        maxFiles: "",
        maxTotalMegabytes: "",
      }
    : {
        expiry:
          mode.request.expiresAt === null
            ? ""
            : localDateTimeInput(mode.request.expiresAt),
        note: mode.request.note ?? "",
        maxFileMegabytes: ByteSize.toMegabytesInput(mode.request.maxFileBytes),
        maxFiles:
          mode.request.maxFiles === null ? "" : String(mode.request.maxFiles),
        maxTotalMegabytes: ByteSize.toMegabytesInput(
          mode.request.maxTotalBytes,
        ),
      };

const settingsFor = (draft: Draft) => ({
  expiresAt: draft.expiry ? new Date(draft.expiry).getTime() : null,
  note: draft.note.trim() || null,
  maxFileBytes: ByteSize.fromMegabytesInput(draft.maxFileMegabytes),
  maxFiles: draft.maxFiles ? Number(draft.maxFiles) : null,
  maxTotalBytes: ByteSize.fromMegabytesInput(draft.maxTotalMegabytes),
});

type PasswordChoice = "keep" | "set" | "remove";
const passwordChoices: Record<PasswordChoice, string> = {
  keep: "Keep current password",
  set: "Change password",
  remove: "Remove password",
};

export default function FileRequestDialog({
  mode,
  onClose,
}: {
  mode: FileRequestDialogMode;
  onClose: () => void;
}) {
  const protectedRequest =
    mode.kind === "edit" && mode.request.passwordProtected;
  const [draft, setDraft] = useState(() => draftFor(mode));
  const [choice, setChoice] = useState<PasswordChoice>(
    protectedRequest ? "keep" : "set",
  );
  const [password, setPassword] = useState("");
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = (key: keyof Draft) => ({
    value: draft[key],
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft({ ...draft, [key]: event.target.value }),
  });
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode.kind === "create") {
        const result = await trpcClient.fileRequests.create.mutate({
          path: mode.folder.path,
          ...settingsFor(draft),
          ...(password ? { password } : {}),
        });
        setLink(`${window.location.origin}/r/${result.token}`);
      } else {
        await trpcClient.fileRequests.update.mutate({
          id: mode.request.id,
          ...settingsFor(draft),
          password:
            choice === "remove"
              ? { kind: "remove" }
              : choice === "set" && password
                ? { kind: "set", value: password }
                : { kind: "keep" },
        });
        onClose();
      }
      await queryClient.invalidateQueries({ queryKey: ["file-requests"] });
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The file request could not be saved. Nothing changed. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  const name =
    mode.kind === "create" ? mode.folder.name : mode.request.path || "My Drive";
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
            {mode.kind === "create" ? "Request files for" : "Edit request for"}{" "}
            {name}
          </DialogTitle>
          <DialogDescription className="text-pretty">
            Anyone with the link can upload into this folder. They cannot see,
            open, replace, or delete its files.
          </DialogDescription>
        </DialogHeader>
        {link ? (
          <div className="space-y-3">
            <Label htmlFor="file-request-link">Upload link</Label>
            <div className="flex gap-2">
              <Input
                id="file-request-link"
                value={link}
                readOnly
                onFocus={(event) => event.target.select()}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  navigator.clipboard
                    .writeText(link)
                    .catch(() =>
                      setError(
                        "Copy failed. Select the link and copy it manually.",
                      ),
                    );
                }}
              >
                Copy
              </Button>
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" onClick={onClose}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <Label htmlFor="file-request-note">
              Note for uploaders (optional)
            </Label>
            <textarea
              id="file-request-note"
              maxLength={1000}
              rows={3}
              className="border-input dark:bg-input/30 placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 w-full min-w-0 resize-y rounded-md border bg-transparent px-3 py-2 text-base shadow-xs outline-none focus-visible:ring-[3px] md:text-sm"
              {...field("note")}
            />
            {protectedRequest && (
              <>
                <Label htmlFor="file-request-password-choice">Password</Label>
                <Select
                  items={passwordChoices}
                  value={choice}
                  onValueChange={(value) => {
                    if (value !== null) setChoice(value);
                  }}
                >
                  <SelectTrigger
                    id="file-request-password-choice"
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
            {choice === "set" && (
              <>
                <Label htmlFor="file-request-password">
                  {protectedRequest ? "New password" : "Password (optional)"}
                </Label>
                <Input
                  id="file-request-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={128}
                  required={protectedRequest}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </>
            )}
            <Label htmlFor="file-request-expiry">Expires (optional)</Label>
            <Input
              id="file-request-expiry"
              type="datetime-local"
              {...field("expiry")}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="file-request-max-file">Largest file (MB)</Label>
                <Input
                  id="file-request-max-file"
                  type="number"
                  inputMode="decimal"
                  min={0.01}
                  step="any"
                  {...field("maxFileMegabytes")}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="file-request-max-files">Number of files</Label>
                <Input
                  id="file-request-max-files"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={100000}
                  step={1}
                  {...field("maxFiles")}
                />
              </div>
            </div>
            <Label htmlFor="file-request-max-total">Total size (MB)</Label>
            <Input
              id="file-request-max-total"
              type="number"
              inputMode="decimal"
              min={0.01}
              step="any"
              {...field("maxTotalMegabytes")}
            />
            <p className="text-pretty text-xs text-muted-foreground">
              Leave limits empty for none. Uploads never replace existing files;
              matching names get a number added.
            </p>
            {error && (
              <p role="alert" className="text-pretty text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button disabled={busy}>
                {mode.kind === "create" ? "Create upload link" : "Save changes"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
