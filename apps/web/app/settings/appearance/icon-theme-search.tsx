import { useState } from "react";
import { TRPCClientError } from "@trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { FieldLabel } from "@/components/ui/field";
import { trpcClient } from "@/lib/trpc";

type Imported = { added: { id: string; name: string }[]; skipped: string[] };
type Extension = {
  namespace: string;
  name: string;
  version: string;
  displayName: string;
  description: string | null;
};
type SearchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; extensions: Extension[] }
  | { status: "error"; error: string };
type ImportState =
  | { status: "idle" }
  | { status: "importing"; namespace: string; name: string }
  | { status: "done"; imported: Imported }
  | { status: "error"; error: string };

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
  const [search, setSearch] = useState<SearchState>({ status: "idle" });
  const [install, setInstall] = useState<ImportState>({ status: "idle" });
  const importing = install.status === "importing";

  async function find(text: string) {
    setSearch({ status: "loading" });
    setInstall({ status: "idle" });
    try {
      const extensions = await trpcClient.appearance.searchIconSets.query({
        query: text,
      });
      setSearch({ status: "ready", extensions });
    } catch (error) {
      setSearch({ status: "error", error: message(error) });
    }
  }

  async function add(extension: { namespace: string; name: string }) {
    setInstall({ status: "importing", ...extension });
    try {
      const imported =
        await trpcClient.appearance.importIconSets.mutate(extension);
      setInstall({ status: "done", imported });
      onImported(imported);
    } catch (error) {
      setInstall({ status: "error", error: message(error) });
    }
  }

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
          if (query.trim()) void find(query.trim());
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
            disabled ||
            !query.trim() ||
            search.status === "loading" ||
            importing
          }
        >
          Search
        </Button>
      </form>
      {search.status === "loading" && (
        <div role="status" className="space-y-2">
          <span className="sr-only">Searching Open VSX…</span>
          <Skeleton className="h-16 motion-reduce:animate-none" />
          <Skeleton className="h-16 motion-reduce:animate-none" />
        </div>
      )}
      {search.status === "error" && (
        <p role="alert" className="text-pretty text-sm text-destructive">
          {search.error}
        </p>
      )}
      {search.status === "ready" &&
        (search.extensions.length === 0 ? (
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
            {search.extensions.map((extension) => {
              const id = `${extension.namespace}.${extension.name}`;
              const busy =
                install.status === "importing" &&
                install.namespace === extension.namespace &&
                install.name === extension.name;
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
                    disabled={disabled || importing}
                    onClick={() =>
                      void add({
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
      {install.status === "error" && (
        <p role="alert" className="text-pretty text-sm text-destructive">
          {install.error}
        </p>
      )}
      {install.status === "done" && (
        <p role="status" className="text-pretty text-sm text-muted-foreground">
          {`Added ${install.imported.added.map((set) => set.name).join(", ")}.`}
          {install.imported.skipped.length > 0 &&
            ` Skipped: ${install.imported.skipped.join(" ")}`}
        </p>
      )}
    </div>
  );
}
