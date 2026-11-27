import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { FieldLabel } from "@/components/ui/field";
import { trpcClient } from "@/lib/trpc";
import { cn } from "@/lib/utils";

type Imported = { added: { id: string; name: string }[]; skipped: string[] };

const message = (error: unknown) =>
  error instanceof TRPCClientError
    ? error.message
    : "Nimbus could not reach the server. Check your connection and try again. Your icon sets are unchanged.";

/**
 * Finds file icon themes on Open VSX and imports one. The Nimbus server makes every request to
 * Open VSX and stores what it imports; this browser only names the extension.
 */
export function IconThemeSearch({
  onImported,
  disabled,
}: {
  onImported: (result: Imported) => void;
  disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const search = useMutation({
    mutationFn: (text: string) =>
      trpcClient.appearance.searchIconSets.query({ query: text }),
  });
  const install = useMutation({
    mutationFn: (extension: { namespace: string; name: string }) =>
      trpcClient.appearance.importIconSets.mutate(extension),
    onSuccess: onImported,
  });
  const installing = install.isPending ? install.variables : null;

  return (
    <div className="space-y-3">
      <p className="text-pretty text-sm text-muted-foreground">
        Find VS Code file icon themes on{" "}
        <a
          className="underline underline-offset-4"
          href="https://open-vsx.org"
          target="_blank"
          rel="noreferrer"
        >
          Open VSX
        </a>
        . Nimbus downloads them to the server, so they follow your account.
        Themes made of SVG or PNG icons work; font-based ones do not.
      </p>
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (query.trim()) search.mutate(query.trim());
        }}
      >
        <div className="min-w-0 flex-1 space-y-2">
          <FieldLabel htmlFor="icon-theme-search">
            Search icon themes
          </FieldLabel>
          <Input
            id="icon-theme-search"
            type="search"
            placeholder="Material, Catppuccin, Symbols…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={200}
          />
        </div>
        <Button
          type="submit"
          variant="tertiary"
          disabled={
            disabled || !query.trim() || search.isPending || install.isPending
          }
        >
          Search
        </Button>
      </form>
      {search.isPending && (
        <div role="status" className="space-y-2">
          <span className="sr-only">Searching Open VSX…</span>
          <Skeleton className="h-16 motion-reduce:animate-none" />
          <Skeleton className="h-16 motion-reduce:animate-none" />
        </div>
      )}
      {search.isError && (
        <p role="alert" className="text-pretty text-sm text-destructive">
          {message(search.error)}
        </p>
      )}
      {search.isSuccess &&
        (search.data.length === 0 ? (
          <p
            role="status"
            className="text-pretty text-sm text-muted-foreground"
          >
            No file icon themes found. Try a different search.
          </p>
        ) : (
          <ul
            aria-label="Icon themes on Open VSX"
            className="max-h-80 space-y-2 overflow-y-auto"
          >
            {search.data.map((extension) => {
              const id = `${extension.namespace}.${extension.name}`;
              const busy =
                installing?.namespace === extension.namespace &&
                installing.name === extension.name;
              return (
                <li
                  key={id}
                  className="flex items-center gap-3 rounded-lg border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {extension.displayName}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {extension.namespace} · {extension.version}
                    </p>
                    {extension.description && (
                      <p className="mt-1 line-clamp-2 text-pretty text-xs text-muted-foreground">
                        {extension.description}
                      </p>
                    )}
                  </div>
                  <Button
                    variant="tertiary"
                    size="compact"
                    aria-label={`Add ${extension.displayName}`}
                    disabled={disabled || install.isPending}
                    onClick={() =>
                      install.mutate({
                        namespace: extension.namespace,
                        name: extension.name,
                      })
                    }
                  >
                    {busy ? "Adding…" : "Add"}
                  </Button>
                </li>
              );
            })}
          </ul>
        ))}
      {(install.isError || install.isSuccess) && (
        <p
          role={install.isError ? "alert" : "status"}
          className={cn(
            "text-pretty text-sm",
            install.isError ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {install.isError
            ? message(install.error)
            : `Added ${install.data.added.map((set) => set.name).join(", ")}.${install.data.skipped.length ? ` Skipped: ${install.data.skipped.join(" ")}` : ""}`}
        </p>
      )}
    </div>
  );
}
