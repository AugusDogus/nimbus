import { useState } from "react";
import { refreshAccount } from "@/lib/account-refresh";
import { ShieldCheck } from "lucide-react";
import * as z from "zod/mini";
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
import { securityClient } from "@/lib/security-client";
import { SettingsSection } from "../settings-section";
import { CopyField } from "../webdav/copy-field";

const enrollment = z.object({
  totpURI: z.string(),
  backupCodes: z.array(z.string()),
  qrCode: z.string().check(z.startsWith("data:image/svg+xml,")),
});

type Flow =
  | { kind: "closed" }
  | { kind: "password"; purpose: "enable" | "disable" | "codes" }
  | { kind: "scan"; qrCode: string; secret: string; backupCodes: string[] }
  | { kind: "codes"; backupCodes: string[] };

const secretFrom = (uri: string) =>
  new URL(uri).searchParams.get("secret") ?? "";

const failure = (
  error: { message?: string | undefined; code?: string | undefined },
  fallback: string,
) =>
  error.code === "INVALID_PASSWORD"
    ? "That password is incorrect. Nothing was changed."
    : (error.message ?? fallback);

export function TwoFactorSettings({ enabled }: { enabled: boolean }) {
  const [flow, setFlow] = useState<Flow>({ kind: "closed" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    if (busy) return;
    const changed = flow.kind === "codes";
    setFlow({ kind: "closed" });
    setError(null);
    if (changed) void refreshAccount();
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch {
      setError(
        "The server could not be reached. Nothing was changed. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  const open = (purpose: "enable" | "disable" | "codes") => {
    setError(null);
    setFlow({ kind: "password", purpose });
  };

  return (
    <SettingsSection
      title="Two-factor authentication"
      description="Ask for a code from an authenticator app after your password."
    >
      <div className="flex flex-col items-start justify-between gap-4 px-4 py-5 sm:flex-row sm:items-center sm:px-5">
        <div className="flex items-start gap-3">
          <ShieldCheck
            className="mt-0.5 size-5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="space-y-1">
            <p className="text-sm font-medium">{enabled ? "On" : "Off"}</p>
            <p className="max-w-prose text-pretty text-sm text-muted-foreground">
              {enabled
                ? "Signing in with your password also needs a code from your authenticator app or a recovery code."
                : "Anyone with your password can sign in. Turn this on to require a code as well."}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {enabled ? (
            <>
              <Button variant="tertiary" onClick={() => open("codes")}>
                New recovery codes
              </Button>
              <Button variant="tertiary" onClick={() => open("disable")}>
                Turn off
              </Button>
            </>
          ) : (
            <Button onClick={() => open("enable")}>Set up</Button>
          )}
        </div>
      </div>
      <Dialog
        open={flow.kind !== "closed"}
        onOpenChange={(value) => !value && close()}
      >
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl [&>*]:min-w-0"
          showCloseButton={!busy && flow.kind !== "codes"}
        >
          {flow.kind === "password" && (
            <form
              className="space-y-5"
              onSubmit={(event) => {
                event.preventDefault();
                const password = new FormData(event.currentTarget).get(
                  "password",
                );
                if (typeof password !== "string") return;
                const purpose = flow.purpose;
                void run(async () => {
                  if (purpose === "enable") {
                    const result = await securityClient.twoFactor.enable({
                      password,
                    });
                    if (result.error)
                      return setError(
                        failure(
                          result.error,
                          "Two-factor authentication could not be set up.",
                        ),
                      );
                    const data = enrollment.safeParse(result.data);
                    if (!data.success)
                      return setError(
                        "The server returned an unexpected enrollment response. Two-factor authentication is still off. Try again.",
                      );
                    setFlow({
                      kind: "scan",
                      qrCode: data.data.qrCode,
                      secret: secretFrom(data.data.totpURI),
                      backupCodes: data.data.backupCodes,
                    });
                  } else if (purpose === "disable") {
                    const result = await securityClient.twoFactor.disable({
                      password,
                    });
                    if (result.error)
                      return setError(
                        failure(
                          result.error,
                          "Two-factor authentication could not be turned off.",
                        ),
                      );
                    setFlow({ kind: "closed" });
                    void refreshAccount();
                  } else {
                    const result =
                      await securityClient.twoFactor.generateBackupCodes({
                        password,
                      });
                    if (result.error)
                      return setError(
                        failure(
                          result.error,
                          "New recovery codes could not be created.",
                        ),
                      );
                    setFlow({
                      kind: "codes",
                      backupCodes: result.data.backupCodes,
                    });
                  }
                });
              }}
            >
              <DialogHeader className="text-left">
                <DialogTitle className="text-balance">
                  {flow.purpose === "enable"
                    ? "Set up two-factor authentication"
                    : flow.purpose === "disable"
                      ? "Turn off two-factor authentication?"
                      : "Create new recovery codes?"}
                </DialogTitle>
                <DialogDescription className="text-pretty">
                  {flow.purpose === "enable"
                    ? "Confirm your password to continue."
                    : flow.purpose === "disable"
                      ? "Signing in will need only your password or a passkey. Confirm your password to turn it off."
                      : "Your current recovery codes will stop working. Confirm your password to continue."}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="two-factor-password">Password</Label>
                <Input
                  id="two-factor-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  autoFocus
                  disabled={busy}
                />
              </div>
              {error && (
                <p
                  role="alert"
                  className="text-pretty text-sm text-destructive"
                >
                  {error}
                </p>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="tertiary"
                  disabled={busy}
                  onClick={close}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={busy}
                  variant={
                    flow.purpose === "disable" ? "destructive" : "primary"
                  }
                >
                  {busy
                    ? "Checking…"
                    : flow.purpose === "disable"
                      ? "Turn off"
                      : "Continue"}
                </Button>
              </DialogFooter>
            </form>
          )}
          {flow.kind === "scan" && (
            <form
              className="space-y-5"
              onSubmit={(event) => {
                event.preventDefault();
                const code = new FormData(event.currentTarget).get("code");
                if (typeof code !== "string") return;
                const backupCodes = flow.backupCodes;
                void run(async () => {
                  const result = await securityClient.twoFactor.verifyTotp({
                    code: code.replace(/\s/g, ""),
                  });
                  if (result.error)
                    return setError(
                      result.error.code === "INVALID_CODE"
                        ? "That code did not match. Check the time on your device and enter the newest code."
                        : (result.error.message ??
                            "The code could not be checked. Try again."),
                    );
                  setFlow({ kind: "codes", backupCodes });
                });
              }}
            >
              <DialogHeader className="text-left">
                <DialogTitle className="text-balance">
                  Scan with your authenticator app
                </DialogTitle>
                <DialogDescription className="text-pretty">
                  Scan the code, or enter the setup key by hand. Then enter the
                  6-digit code the app shows.
                </DialogDescription>
              </DialogHeader>
              {/* A data URL keeps the secret out of request logs and caches. */}
              <img
                src={flow.qrCode}
                alt="QR code for your authenticator app"
                width={192}
                height={192}
                className="mx-auto size-48 rounded-lg border border-border/60"
              />
              <div className="space-y-2">
                <p className="text-sm font-medium">Setup key</p>
                <CopyField label="Setup key" value={flow.secret} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="two-factor-code">Code from the app</Label>
                <Input
                  id="two-factor-code"
                  name="code"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  pattern="[0-9 ]{6,7}"
                  maxLength={7}
                  required
                  disabled={busy}
                  className="font-mono tracking-widest"
                />
              </div>
              {error && (
                <p
                  role="alert"
                  className="text-pretty text-sm text-destructive"
                >
                  {error}
                </p>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="tertiary"
                  disabled={busy}
                  onClick={close}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? "Verifying…" : "Turn on"}
                </Button>
              </DialogFooter>
            </form>
          )}
          {flow.kind === "codes" && (
            <>
              <DialogHeader className="text-left">
                <DialogTitle className="text-balance">
                  Save your recovery codes
                </DialogTitle>
                <DialogDescription className="text-pretty">
                  Two-factor authentication is on. If you lose your
                  authenticator, each code signs you in once. Store them
                  somewhere safe; you won’t see them again.
                </DialogDescription>
              </DialogHeader>
              <ul
                aria-label="Recovery codes"
                className="grid grid-cols-2 gap-2 rounded-xl border border-border/60 bg-background p-4 font-mono text-sm tabular-nums"
              >
                {flow.backupCodes.map((code) => (
                  <li key={code}>{code}</li>
                ))}
              </ul>
              <CopyField
                label="Recovery codes"
                value={flow.backupCodes.join(" ")}
              />
              <DialogFooter>
                <Button onClick={close}>I’ve saved them</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}
