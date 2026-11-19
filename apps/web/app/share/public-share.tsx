import { useState } from "react";
import { LinkUnlock } from "@/lib/link-unlock";
import { useHydrated } from "@/lib/use-hydrated";
import { useServerField } from "@/lib/use-server-field";
import { useLocalTime } from "@/lib/use-local-time";
import { useQuery } from "@tanstack/react-query";
import { FileText, Folder } from "lucide-react";
import { NimbusLogo } from "@/components/nimbus-logo";
import { NimbusWordmark } from "@/components/nimbus-wordmark";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  EntryThumbnail,
  hasThumbnail,
} from "@/app/drive/files/entry-thumbnail";
import {
  publicShareQuery,
  shareEndpoint,
  sharePagesUrl,
  shareUrl,
} from "./share-result";
import { FilePreview } from "@/app/drive/files/preview-dialog";

function Expiry({ time }: { time: number }) {
  const text = useLocalTime(time, "date");
  return text ? ` · Expires ${text}` : null;
}

export function PublicShare({ token }: { token: string }) {
  const [path, setPath] = useState("");
  const [password, setPassword] = useState("");
  // What was typed or autofilled before the page's code ran.
  const passwordField = useServerField(setPassword);
  const hydrated = useHydrated();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const endpoint = shareEndpoint(token);
  const url = shareUrl(token, path);
  const share = useQuery(publicShareQuery(token, path));
  const unavailable = share.isError
    ? share.error.message
    : share.data?.kind === "unavailable"
      ? share.data.message
      : null;
  return (
    <div className="mx-auto min-h-dvh max-w-5xl px-4 pb-12">
      <header className="mb-8 flex h-16 items-center justify-between border-b">
        <div className="flex items-center gap-2 font-semibold">
          <NimbusLogo className="size-8" />
          <NimbusWordmark />
        </div>
        <ThemeToggle />
      </header>
      {share.isPending ? (
        <p>Loading shared files…</p>
      ) : unavailable !== null ||
        !share.data ||
        share.data.kind === "unavailable" ? (
        <div className="space-y-3 rounded-lg border p-6">
          <h1 className="text-balance text-xl font-semibold">
            Share unavailable
          </h1>
          <p role="alert" className="text-pretty text-muted-foreground">
            {unavailable}
          </p>
        </div>
      ) : share.data.kind === "locked" ? (
        <form
          className="mx-auto max-w-sm space-y-4 rounded-lg border p-6"
          onSubmit={(event) =>
            void (async () => {
              event.preventDefault();
              setBusy(true);
              setError(null);
              try {
                const response = await fetch(endpoint, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ password }),
                });
                if (!response.ok)
                  throw new Error(
                    await LinkUnlock.failure(
                      response,
                      "Could not unlock this share. Try again.",
                    ),
                  );
                setPassword("");
                await share.refetch();
              } catch (error) {
                setError(
                  error instanceof Error
                    ? error.message
                    : "Could not unlock this share.",
                );
              } finally {
                setBusy(false);
              }
            })()
          }
        >
          <h1 className="text-balance text-xl font-semibold">
            Protected share
          </h1>
          <p className="text-pretty text-sm text-muted-foreground">
            Enter the password provided by the owner.
          </p>
          <Label htmlFor="share-password">Password</Label>
          <Input
            ref={passwordField}
            id="share-password"
            type="password"
            required
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {/* Before hydration a click would submit the form natively and reload the page. */}
          <Button type="submit" disabled={!hydrated || busy}>
            {/* A link with many recent attempts checks one every few seconds. */}
            {busy ? "Unlocking…" : "Unlock"}
          </Button>
        </form>
      ) : (
        <main className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-balance break-all text-2xl font-semibold">
                {share.data.entry.name}
              </h1>
              <p className="text-pretty mt-1 text-sm text-muted-foreground">
                {share.data.mode === "view"
                  ? "Preview only"
                  : "Shared read-only"}
                {share.data.expiresAt !== null && (
                  <Expiry time={share.data.expiresAt} />
                )}
              </p>
            </div>
            {share.data.mode === "download" && (
              <a
                href={`${url}&download=1`}
                download
                className={buttonVariants()}
              >
                {share.data.entry.type === "dir" ? "Download ZIP" : "Download"}
              </a>
            )}
          </div>
          {path && (
            <Button
              variant="outline"
              onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}
            >
              Parent folder
            </Button>
          )}
          {share.data.entry.type === "file" ? (
            <FilePreview
              name={share.data.entry.name}
              url={`${url}&preview=1`}
              pagesUrl={sharePagesUrl(token, path)}
            />
          ) : share.data.entries.length === 0 ? (
            <p className="text-muted-foreground">
              This shared folder is empty.
            </p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {share.data.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    className="flex w-full items-center gap-3 p-4 text-left hover:bg-accent"
                    onClick={() => setPath(entry.path)}
                  >
                    {entry.type === "dir" ? (
                      <Folder className="size-5 shrink-0" />
                    ) : hasThumbnail(entry) ? (
                      <EntryThumbnail
                        entry={entry}
                        share={token}
                        fallback={<FileText className="size-5 shrink-0" />}
                        className="-my-1.5 size-8 overflow-hidden rounded-sm"
                      />
                    ) : (
                      <FileText className="size-5 shrink-0" />
                    )}
                    <span className="truncate text-sm">{entry.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </main>
      )}
    </div>
  );
}
