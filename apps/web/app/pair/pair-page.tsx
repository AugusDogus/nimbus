import { useState } from "react";
import { MonitorSmartphone, ShieldAlert } from "lucide-react";
import { Link } from "@/components/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageSurface } from "@/components/page-surface";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { FieldLabel } from "@/components/ui/field";
import { UploadProgress } from "@/components/upload-progress";
import { trpcClient } from "@/lib/trpc";
import type { PairingReview } from "@/server/libraries/device-pairing";

type Step =
  | { kind: "enter"; error: string | null }
  | { kind: "review"; review: PairingReview; error: string | null }
  | { kind: "done"; outcome: "approved" | "denied"; deviceName: string };

const messageOf = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/** "2 minutes ago", from a time on the server's clock. */
function age(milliseconds: number) {
  const minutes = Math.max(0, Math.round((Date.now() - milliseconds) / 60_000));
  return minutes < 1
    ? "less than a minute ago"
    : `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
}

/**
 * Approve or deny a device that shows a pairing code. Nothing is approved by opening the page,
 * even from a QR code: the owner checks the request and chooses Allow or Deny.
 */
export function PairPage({
  initialCode,
  email,
}: {
  initialCode: string;
  email: string;
}) {
  const [code, setCode] = useState(initialCode);
  const [step, setStep] = useState<Step>({ kind: "enter", error: null });
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const lookUp = async () => {
    setBusy(true);
    try {
      const review = await trpcClient.libraries.review.mutate({
        pairingCode: code,
      });
      const [only] = review.libraries;
      setLibraryId(review.libraries.length === 1 && only ? only.id : null);
      setStep({ kind: "review", review, error: null });
    } catch (error) {
      setStep({
        kind: "enter",
        error: messageOf(
          error,
          "Nimbus could not check the code. Check your connection and try again.",
        ),
      });
    } finally {
      setBusy(false);
    }
  };

  const decide = async (review: PairingReview, approve: boolean) => {
    if (approve && libraryId === null) return;
    setBusy(true);
    try {
      const decided = await trpcClient.libraries.decide.mutate({
        pairingId: review.pairingId,
        ticket: review.ticket,
        decision:
          approve && libraryId !== null
            ? { kind: "approve", libraryId }
            : { kind: "deny" },
      });
      setStep({
        kind: "done",
        outcome: approve ? "approved" : "denied",
        deviceName: decided.deviceName,
      });
    } catch (error) {
      setStep({
        kind: "review",
        review,
        error: messageOf(
          error,
          "Nimbus could not record your choice. The device is not paired; try again.",
        ),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header
        className={cn(
          PageSurface.header,
          "sticky top-0 z-10 flex h-16 shrink-0 items-center gap-3 px-4 md:px-6",
        )}
      >
        <SidebarTrigger className="touch-hit size-8 shrink-0 text-muted-foreground" />
        <h1 className="text-sm font-medium">Pair a device</h1>
      </header>
      <UploadProgress />
      <div data-slot="page-card" className={cn("flex-1", PageSurface.card)}>
        <div className="mx-auto w-full max-w-lg space-y-6 px-4 py-6 md:py-10">
          <p className="text-pretty text-sm text-muted-foreground">
            Signed in as{" "}
            <span className="font-medium text-foreground">{email}</span>
          </p>
          {step.kind === "enter" && (
            <form
              className="space-y-4 rounded-2xl border border-border/60 bg-card/40 p-5"
              onSubmit={(event) => {
                event.preventDefault();
                void lookUp();
              }}
            >
              <div className="space-y-2">
                <FieldLabel htmlFor="pairing-code">
                  Code shown on the device
                </FieldLabel>
                <Input
                  id="pairing-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="ABCD-EFGH"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={20}
                  required
                  disabled={busy}
                  className="font-mono tracking-widest uppercase"
                />
              </div>
              {step.error && (
                <p
                  role="alert"
                  className="text-pretty text-sm text-destructive"
                >
                  {step.error}
                </p>
              )}
              <Button type="submit" disabled={busy || !code.trim()}>
                {busy ? "Checking…" : "Continue"}
              </Button>
            </form>
          )}
          {step.kind === "review" && (
            <div className="space-y-5 rounded-2xl border border-border/60 bg-card/40 p-5">
              <div className="flex items-start gap-3">
                <MonitorSmartphone
                  className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div className="min-w-0 space-y-1">
                  <p className="break-words text-sm font-medium">
                    “<bdi>{step.review.deviceName}</bdi>”
                  </p>
                  <p className="flex flex-wrap gap-x-1.5 text-xs text-muted-foreground">
                    <span>Name supplied by the device</span>
                    <span aria-hidden="true">·</span>
                    <span className="whitespace-nowrap">
                      asked {age(step.review.requestedAt)}
                    </span>
                  </p>
                </div>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Code</dt>
                <dd
                  className="font-mono tracking-widest"
                  data-testid="pairing-code"
                >
                  {step.review.pairingCode}
                </dd>
                <dt className="text-muted-foreground">Account</dt>
                <dd className="break-all">{step.review.account.email}</dd>
              </dl>
              {step.review.libraries.length === 0 ? (
                <div className="space-y-2 text-sm">
                  <p className="font-medium">You have no libraries yet</p>
                  <p className="text-pretty text-muted-foreground">
                    A device can only be paired with a library: folders you
                    choose to offer it. Create one, then return to this page
                    while the code is still shown on the device.
                  </p>
                  <Button
                    variant="tertiary"
                    render={<Link to="/settings/libraries" />}
                  >
                    Create a library
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <FieldLabel htmlFor="pairing-library">Library</FieldLabel>
                  <Select
                    value={libraryId ?? ""}
                    onValueChange={(value) => setLibraryId(value || null)}
                  >
                    <SelectTrigger
                      id="pairing-library"
                      className="w-full"
                      placeholder="Choose a library"
                    />
                    <SelectContent>
                      {step.review.libraries.map((library, index) => (
                        <SelectItem
                          index={index}
                          key={library.id}
                          value={library.id}
                        >
                          {library.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {libraryId !== null && (
                    <p className="text-pretty text-xs text-muted-foreground">
                      Folders:{" "}
                      {step.review.libraries
                        .find((library) => library.id === libraryId)
                        ?.folders.join(", ")}
                    </p>
                  )}
                </div>
              )}
              <div className="space-y-1 text-sm">
                <p className="font-medium">If you allow it, this device can</p>
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                  <li>
                    See and open the files in the library you choose, including
                    files added to its folders later
                  </li>
                  <li>Nothing else: it cannot change, delete or share files</li>
                </ul>
                <p className="pt-1 text-pretty text-xs text-muted-foreground">
                  It stays paired until you disconnect it in Settings,
                  Libraries, or it goes unused for 30 days.
                </p>
              </div>
              <p className="flex gap-2 rounded-xl border border-border/60 bg-background p-3 text-pretty text-sm">
                <ShieldAlert
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span>
                  Approve only a code shown on a device you are setting up right
                  now. Someone else&apos;s code would give their device access
                  to this library.
                </span>
              </p>
              {step.error && (
                <p
                  role="alert"
                  className="text-pretty text-sm text-destructive"
                >
                  {step.error}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy || libraryId === null}
                  onClick={() => void decide(step.review, true)}
                >
                  Allow
                </Button>
                <Button
                  variant="tertiary"
                  disabled={busy}
                  onClick={() => void decide(step.review, false)}
                >
                  Deny
                </Button>
              </div>
            </div>
          )}
          {step.kind === "done" && (
            <div
              role="status"
              className="space-y-2 rounded-2xl border border-border/60 bg-card/40 p-5"
            >
              <p className="text-sm font-medium">
                “<bdi>{step.deviceName}</bdi>”{" "}
                {step.outcome === "approved" ? "is paired" : "was not paired"}
              </p>
              <p className="text-pretty text-sm text-muted-foreground">
                {step.outcome === "approved"
                  ? "The device finishes signing in by itself in a few seconds. You can disconnect it at any time in Settings, Libraries."
                  : "The device gets no access. You can close this page."}
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
