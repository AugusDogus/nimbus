"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { FileText, Folder, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { trpcClient } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { PreviewDialog } from "../[[...path]]/preview-dialog";
import { fileHref, type FileEntry } from "../[[...path]]/types";
import { Highlighted, parentLabel } from "./highlight";

const SUGGESTIONS = 8;

function useDebounced<T>(value: T, delayMs: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Header search: suggestions while typing, full results on Enter. */
export function SearchBox() {
  const router = useRouter();
  const listId = useId();
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [preview, setPreview] = useState<FileEntry | null>(null);
  const query = useDebounced(value.trim(), 80);
  const results = useQuery({
    queryKey: ["catalog", "search", query, SUGGESTIONS],
    queryFn: ({ signal }) =>
      trpcClient.catalog.search.query(
        { query, path: "", limit: SUGGESTIONS },
        { signal },
      ),
    enabled: query.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 5_000,
  });
  const entries = query ? (results.data?.entries ?? []) : [];
  const expanded = open && value.trim().length > 0;
  const choose = (entry: FileEntry) => {
    setOpen(false);
    if (entry.type === "dir") router.push(fileHref(entry.path));
    else setPreview(entry);
  };
  const showAll = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setOpen(false);
    router.push(`/search?q=${encodeURIComponent(trimmed)}`);
  };
  const activeEntry = entries[active];
  return (
    <>
      <form
        role="search"
        className="relative min-w-0 max-w-lg flex-1"
        onSubmit={(event) => {
          event.preventDefault();
          if (expanded && activeEntry) choose(activeEntry);
          else showAll();
        }}
      >
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          name="q"
          role="combobox"
          aria-label="Search files"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-activedescendant={
            expanded && activeEntry ? `${listId}-${active}` : undefined
          }
          autoComplete="off"
          placeholder="Search files"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setActive(-1);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && expanded) {
              event.preventDefault();
              setOpen(false);
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              const step = event.key === "ArrowDown" ? 1 : -1;
              // -1 returns focus to the text, matching native combobox behavior.
              setActive((current) =>
                entries.length
                  ? ((current + step + 1 + entries.length + 1) %
                      (entries.length + 1)) -
                    1
                  : -1,
              );
            }
          }}
          className="h-9 rounded-lg border-transparent bg-muted/70 pl-10 shadow-none focus-visible:border-ring md:h-10 dark:bg-sidebar/70"
        />
        <div
          id={listId}
          role="listbox"
          aria-label="Search suggestions"
          hidden={!expanded}
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-[min(70dvh,28rem)] overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {entries.map((entry, index) => {
            const Icon = entry.type === "dir" ? Folder : FileText;
            return (
              <div
                key={entry.path}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                // Keep focus in the input so the list stays open while choosing.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(entry)}
                onMouseMove={() => setActive(index)}
                className={cn(
                  "flex cursor-default items-center gap-3 rounded-md px-2 py-2",
                  index === active && "bg-accent text-accent-foreground",
                )}
              >
                <Icon
                  className={cn(
                    "size-4 shrink-0 text-muted-foreground",
                    entry.type === "dir" && "fill-muted",
                  )}
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm">
                    <Highlighted text={entry.name} query={query} />
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {parentLabel(entry.path)}
                  </span>
                </span>
              </div>
            );
          })}
          <div
            role="option"
            aria-selected={false}
            onMouseDown={(event) => event.preventDefault()}
            onClick={showAll}
            className="cursor-default rounded-md px-2 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            {query && results.isFetched && entries.length === 0
              ? "No matching names. Press Enter to search again."
              : `Show all results for “${value.trim()}”`}
          </div>
        </div>
      </form>
      {/* Outside the form: React events bubble through portals. */}
      {preview && (
        <PreviewDialog
          entry={preview}
          entries={entries.filter((entry) => entry.type === "file")}
          onNavigate={setPreview}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}
