import { useCallback, useEffect, useRef, useState } from "react";
import { useFileDropGuard, useLeaveWarning } from "@/lib/use-file-drop-guard";
import { useHydrated } from "@/lib/use-hydrated";
import { useServerField } from "@/lib/use-server-field";
import { useQuery } from "@tanstack/react-query";
import * as z from "zod/mini";
import { Check, CircleAlert, Upload as UploadIcon } from "lucide-react";
// Already in every page: the root layout's upload provider uses it.
import * as tus from "tus-js-client";
import { NimbusLogo } from "@/components/nimbus-logo";
import { NimbusWordmark } from "@/components/nimbus-wordmark";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ByteSize } from "@/lib/byte-size";
import { useLocalTime } from "@/lib/use-local-time";
import {
  fileRequestEndpoint,
  fileRequestQuery,
  type FileRequestResult,
} from "./file-request-result";

type OpenRequest = Extract<FileRequestResult, { kind: "open" }>;

const errorSchema = z.object({ error: z.string() });

type ItemStatus =
  | { kind: "queued" }
  | { kind: "uploading"; percent: number }
  | { kind: "done" }
  | { kind: "failed"; message: string };
type Item = { id: number; file: File; status: ItemStatus };

function OpenUntil({ time }: { time: number }) {
  const text = useLocalTime(time, "datetime");
  return text ? ` Open until ${text}.` : null;
}

/** tus reports the server's reply body; that is the message worth showing. */
function uploadError(error: unknown) {
  if (error instanceof tus.DetailedError && error.originalResponse) {
    const body = error.originalResponse.getBody();
    if (body.trim()) return body.trim();
  }
  return "The upload was interrupted. Check your connection and add the file again; it resumes where it stopped.";
}

export function FileRequestUpload({ token }: { token: string }) {
  const endpoint = fileRequestEndpoint(token);
  const details = useQuery(fileRequestQuery(token));
  const unavailable = details.isError
    ? details.error.message
    : details.data?.kind === "unavailable"
      ? details.data.message
      : null;
  const [items, setItems] = useState<Item[]>([]);
  // The details are refetched after uploads and on focus. Once files are listed, an answer that
  // fails or finds the link closed must not hide which of them arrived.
  const [opened, setOpened] = useState<OpenRequest | null>(null);
  const latest = details.data?.kind === "open" ? details.data : null;
  if (latest && latest !== opened) setOpened(latest);
  const open = latest ?? (items.length > 0 ? opened : null);
  const refreshProblem =
    open === null
      ? null
      : details.isError
        ? "This link’s details could not be refreshed. The uploads below are unchanged; reload the page to check the link."
        : details.data?.kind === "unavailable"
          ? `${details.data.message} The uploads below are unchanged.`
          : details.data?.kind === "locked"
            ? "This link now needs its password again. The uploads below are unchanged; reload the page to unlock it."
            : null;
  // More files only while the latest answer says the link is open.
  const accepting = details.data?.kind === "open";
  const [dragging, setDragging] = useState(false);
  const [password, setPassword] = useState("");
  // What was typed or autofilled before the page's code ran.
  const passwordField = useServerField(setPassword);
  const hydrated = useHydrated();
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const nextId = useRef(0);
  const active = useRef<tus.Upload | null>(null);
  const running = useRef(false);
  const queue = useRef<Item[]>([]);

  const update = useCallback((id: number, status: ItemStatus) => {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, status } : item)),
    );
  }, []);

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    for (let item = queue.current.shift(); item; item = queue.current.shift()) {
      const { id, file } = item;
      update(id, { kind: "uploading", percent: 0 });
      await new Promise<void>((resolve) => {
        const upload = new tus.Upload(file, {
          endpoint: "/api/file-request/upload",
          retryDelays: [0, 1000, 3000, 5000],
          removeFingerprintOnSuccess: true,
          fingerprint: async () =>
            JSON.stringify([
              "file-request",
              token,
              file.name,
              file.size,
              file.lastModified,
            ]),
          metadata: { filename: file.name, request: token },
          onProgress(sent, total) {
            update(id, {
              kind: "uploading",
              percent: total === 0 ? 100 : Math.round((sent / total) * 100),
            });
          },
          onSuccess() {
            update(id, { kind: "done" });
            resolve();
          },
          onError(error) {
            update(id, { kind: "failed", message: uploadError(error) });
            resolve();
          },
        });
        active.current = upload;
        upload
          .findPreviousUploads()
          .then((previous) => {
            if (previous[0]) upload.resumeFromPreviousUpload(previous[0]);
            upload.start();
          })
          .catch((error: unknown) => {
            update(id, { kind: "failed", message: uploadError(error) });
            resolve();
          });
      });
    }
    active.current = null;
    running.current = false;
    void details.refetch();
  }, [details, token, update]);

  useEffect(
    () => () => {
      queue.current = [];
      void active.current?.abort();
    },
    [],
  );

  const add = (files: FileList | null) => {
    if (!files?.length) return;
    const added = [...files].map((file) => ({
      id: nextId.current++,
      file,
      status: { kind: "queued" } as const,
    }));
    queue.current.push(...added);
    setItems((current) => [...current, ...added]);
    void run();
  };

  const uploading = items.some(
    (item) => item.status.kind === "uploading" || item.status.kind === "queued",
  );
  useFileDropGuard();
  useLeaveWarning(uploading);

  return (
    <div className="mx-auto min-h-dvh max-w-3xl px-4 pb-12">
      <header className="mb-8 flex h-16 items-center justify-between border-b">
        <div className="flex items-center gap-2 font-semibold">
          <NimbusLogo className="size-8" />
          <NimbusWordmark />
        </div>
        <ThemeToggle />
      </header>
      {details.isPending ? (
        <p>Loading upload link…</p>
      ) : open === null &&
        (unavailable !== null ||
          !details.data ||
          details.data.kind === "unavailable") ? (
        <div className="space-y-3 rounded-lg border p-6">
          <h1 className="text-balance text-xl font-semibold">
            Upload link unavailable
          </h1>
          <p role="alert" className="text-pretty text-muted-foreground">
            {unavailable}
          </p>
        </div>
      ) : open === null ? (
        <form
          className="mx-auto max-w-sm space-y-4 rounded-lg border p-6"
          onSubmit={(event) =>
            void (async () => {
              event.preventDefault();
              setBusy(true);
              setUnlockError(null);
              try {
                const response = await fetch(endpoint, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ password }),
                });
                if (!response.ok) {
                  const body = errorSchema.safeParse(await response.json());
                  throw new Error(
                    body.success
                      ? body.data.error
                      : "Could not unlock this link.",
                  );
                }
                setPassword("");
                await details.refetch();
              } catch (error) {
                setUnlockError(
                  error instanceof Error
                    ? error.message
                    : "Could not unlock this link.",
                );
              } finally {
                setBusy(false);
              }
            })()
          }
        >
          <h1 className="text-balance text-xl font-semibold">
            Protected upload link
          </h1>
          <p className="text-pretty text-sm text-muted-foreground">
            Enter the password provided with the link.
          </p>
          <Label htmlFor="request-password">Password</Label>
          <Input
            ref={passwordField}
            id="request-password"
            type="password"
            required
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {unlockError && (
            <p role="alert" className="text-sm text-destructive">
              {unlockError}
            </p>
          )}
          {/* Before hydration a click would submit the form natively and reload the page. */}
          <Button type="submit" disabled={!hydrated || busy}>
            Unlock
          </Button>
        </form>
      ) : (
        <main className="space-y-6">
          <div>
            <h1 className="text-balance break-words text-2xl font-semibold">
              Upload files to {open.folder}
            </h1>
            <p className="mt-1 text-pretty text-sm text-muted-foreground">
              You can add files but cannot see what is already there.
              {open.expiresAt !== null && <OpenUntil time={open.expiresAt} />}
            </p>
          </div>
          {refreshProblem && (
            <p
              role="alert"
              className="text-pretty rounded-lg border border-destructive/50 p-4 text-sm"
            >
              {refreshProblem}
            </p>
          )}
          {open.note && (
            <blockquote className="whitespace-pre-wrap break-words rounded-lg border-l-4 bg-muted p-4 text-sm">
              {open.note}
            </blockquote>
          )}
          <div
            onDragOver={(event) => {
              event.preventDefault();
              if (accepting) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              if (accepting) add(event.dataTransfer.files);
            }}
            data-dragging={dragging || undefined}
            className="flex flex-col items-center gap-3 rounded-lg border-2 border-dashed p-8 text-center transition-colors data-[dragging]:border-primary data-[dragging]:bg-accent"
          >
            <UploadIcon aria-hidden className="size-8 text-muted-foreground" />
            <p className="text-pretty text-sm text-muted-foreground">
              Drag files here, or
            </p>
            <Button
              type="button"
              disabled={!accepting}
              onClick={() => input.current?.click()}
            >
              Choose files
            </Button>
            <input
              ref={input}
              type="file"
              multiple
              className="sr-only"
              aria-label="Files to upload"
              tabIndex={-1}
              onChange={(event) => {
                add(event.target.files);
                event.target.value = "";
              }}
            />
            <p className="text-pretty text-xs tabular-nums text-muted-foreground">
              Up to {ByteSize.format(open.maxFileBytes)} per file
              {open.remainingFiles === null
                ? ""
                : ` · ${open.remainingFiles} more ${open.remainingFiles === 1 ? "file" : "files"} accepted`}
            </p>
          </div>
          {items.length > 0 && (
            <ul aria-label="Uploads" className="divide-y rounded-lg border">
              {items.map((item) => (
                <li key={item.id} className="space-y-2 p-4">
                  <div className="flex items-center gap-3">
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {item.file.name}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {ByteSize.format(item.file.size)}
                    </span>
                    {item.status.kind === "done" ? (
                      <Check
                        role="img"
                        aria-label="Uploaded"
                        className="size-4 shrink-0 text-primary"
                      />
                    ) : item.status.kind === "failed" ? (
                      <CircleAlert
                        role="img"
                        aria-label="Failed"
                        className="size-4 shrink-0 text-destructive"
                      />
                    ) : null}
                  </div>
                  {item.status.kind === "uploading" && (
                    <progress
                      max={100}
                      value={item.status.percent}
                      aria-label={`Uploading ${item.file.name}`}
                      className="block h-2 w-full appearance-none overflow-hidden rounded-full bg-primary/20 [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-transparent [&::-webkit-progress-value]:bg-primary [&::-webkit-progress-value]:transition-[width]"
                    />
                  )}
                  {item.status.kind === "failed" && (
                    <p
                      role="alert"
                      className="text-pretty text-xs text-destructive"
                    >
                      {item.status.message}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p aria-live="polite" className="sr-only">
            {uploading
              ? "Uploading files."
              : items.length
                ? `${items.filter((item) => item.status.kind === "done").length} of ${items.length} files uploaded.`
                : ""}
          </p>
        </main>
      )}
    </div>
  );
}
