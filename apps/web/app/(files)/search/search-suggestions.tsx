"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { FileText, Folder } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
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

/**
 * Combobox behavior for the header's search input: suggestions while typing,
 * arrow keys to choose, Enter to open. Listens on the input element directly
 * because the input is rendered, and stays mounted, outside this chunk.
 */
export default function SearchSuggestions({
  input,
}: {
  input: RefObject<HTMLInputElement | null>;
}) {
  const router = useRouter();
  const id = useId();
  const [value, setValue] = useState(() => input.current?.value ?? "");
  const [open, setOpen] = useState(true);
  const query = useDebounced(value.trim(), 80);
  // Selection belongs to the query it was made for, so typing clears it.
  const [selection, setSelection] = useState({ query: "", index: -1 });
  const active = selection.query === query ? selection.index : -1;
  const [preview, setPreview] = useState<{
    entry: FileEntry;
    files: FileEntry[];
  } | null>(null);
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
  const optionId = (index: number) => `${id}-${index}`;

  const choose = (entry: FileEntry) => {
    setOpen(false);
    if (entry.type === "dir") router.push(fileHref(entry.path));
    else
      setPreview({
        entry,
        files: entries.filter((item) => item.type === "file"),
      });
  };
  const showAll = () => {
    setOpen(false);
    input.current?.form?.requestSubmit();
  };

  // Native listeners read the latest render through this ref.
  const latest = useRef({ entries, active, query, choose });
  useEffect(() => {
    latest.current = { entries, active, query, choose };
  });

  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const onInput = () => {
      setValue(element.value);
      setOpen(true);
    };
    const onFocus = () => setOpen(true);
    const onBlur = () => setOpen(false);
    const onKeyDown = (event: KeyboardEvent) => {
      const { entries, active, query, choose } = latest.current;
      if (event.key === "Escape") {
        setOpen(false);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setOpen(true);
        const states = entries.length + 1;
        const step = event.key === "ArrowDown" ? 1 : -1;
        // -1 is the text itself, as in a native combobox.
        setSelection({
          query,
          index: ((active + 1 + step + states) % states) - 1,
        });
      } else if (event.key === "Enter" && entries[active]) {
        event.preventDefault();
        choose(entries[active]);
      }
    };
    element.addEventListener("input", onInput);
    element.addEventListener("focus", onFocus);
    element.addEventListener("blur", onBlur);
    element.addEventListener("keydown", onKeyDown);
    return () => {
      element.removeEventListener("input", onInput);
      element.removeEventListener("focus", onFocus);
      element.removeEventListener("blur", onBlur);
      element.removeEventListener("keydown", onKeyDown);
    };
  }, [input]);

  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.setAttribute("aria-expanded", String(expanded));
    element.setAttribute("aria-controls", id);
    if (expanded && active >= 0)
      element.setAttribute("aria-activedescendant", optionId(active));
    else element.removeAttribute("aria-activedescendant");
  });

  return (
    <>
      <div
        id={id}
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
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              // Keep focus in the input so the list stays open while choosing.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(entry)}
              onMouseMove={() => setSelection({ query, index })}
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
      {preview && (
        <PreviewDialog
          entry={preview.entry}
          entries={preview.files}
          onNavigate={(entry) => setPreview({ ...preview, entry })}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}
