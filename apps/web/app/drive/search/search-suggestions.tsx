import { FileText, Folder } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { cn } from "@/lib/utils";
import { PreviewDialog } from "../files/preview-dialog";
import { fileHref, type FileEntry } from "../files/types";
import { SplitAddress } from "../files/split/split-address";
import { Highlighted, Location } from "./highlight";
import { useSearch } from "./use-search";

const SUGGESTIONS = 8;
const count = new Intl.NumberFormat();

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
  id,
  input,
  navigate,
}: {
  /** The listbox id, which the input already names in `aria-controls`. */
  id: string;
  input: RefObject<HTMLInputElement | null>;
  navigate: (href: string) => void;
}) {
  // Read from the element, not copied into state: text typed after this renders and before its
  // effects attach listeners reaches no listener, and a copy would keep the text at first render.
  const value = useSyncExternalStore(
    useCallback(
      (changed: () => void) => {
        const element = input.current;
        element?.addEventListener("input", changed);
        return () => element?.removeEventListener("input", changed);
      },
      [input],
    ),
    () => input.current?.value ?? "",
  );
  const [open, setOpen] = useState(true);
  const query = useDebounced(value.trim(), 80);
  // Selection belongs to the text it was made for: any keystroke clears it,
  // so Enter right after typing searches instead of reopening a stale match.
  const [selection, setSelection] = useState({ value: "", index: -1 });
  const active = selection.value === value ? selection.index : -1;
  const [preview, setPreview] = useState<{
    entry: FileEntry;
    files: FileEntry[];
  } | null>(null);
  const results = useSearch(query, SUGGESTIONS);
  const entries = results.entries;
  const expanded = open && value.trim().length > 0;
  const optionId = (index: number) => `${id}-${index}`;

  const choose = (entry: FileEntry) => {
    setOpen(false);
    if (entry.type === "dir") {
      // A split view stays: the folder opens in its active pane.
      const split = SplitAddress.here();
      navigate(
        split
          ? SplitAddress.openInActive(split, entry.path)
          : fileHref(entry.path),
      );
    } else
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
  const latest = useRef({ entries, active, value, choose, showAll });
  useEffect(() => {
    latest.current = { entries, active, value, choose, showAll };
  });

  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const onInput = () => setOpen(true);
    const onFocus = () => setOpen(true);
    const onBlur = () => setOpen(false);
    const onKeyDown = (event: KeyboardEvent) => {
      const { entries, active, value, choose, showAll } = latest.current;
      if (event.key === "Escape") {
        setOpen(false);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setOpen(true);
        // -1 is the text itself, as in a native combobox; after the matches comes "Show all".
        const states = entries.length + 2;
        const step = event.key === "ArrowDown" ? 1 : -1;
        setSelection({
          value,
          index: ((active + 1 + step + states) % states) - 1,
        });
      } else if (event.key === "Enter" && entries[active]) {
        event.preventDefault();
        choose(entries[active]);
      } else if (event.key === "Enter" && active === entries.length) {
        event.preventDefault();
        showAll();
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
    if (expanded && active >= 0)
      element.setAttribute("aria-activedescendant", optionId(active));
    else element.removeAttribute("aria-activedescendant");
  });
  // Focus stays in the input, so the list scrolls the option the arrow keys reach into view.
  useEffect(() => {
    if (expanded && active >= 0)
      document.getElementById(`${id}-${active}`)?.scrollIntoView({
        block: "nearest",
      });
  }, [expanded, active, id]);

  return (
    <>
      <div
        id={id}
        role="listbox"
        aria-label="Search suggestions"
        hidden={!expanded}
        className="absolute inset-x-0 top-full z-20 mt-1 max-h-[min(70dvh,30rem)] overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
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
              onMouseMove={() => setSelection({ value, index })}
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
                  <Highlighted
                    text={entry.name}
                    ranges={entry.highlight.name}
                  />
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  <Location
                    path={entry.path}
                    ranges={
                      entry.path.includes("/") ? entry.highlight.folder : []
                    }
                  />
                </span>
              </span>
            </div>
          );
        })}
        <div
          id={optionId(entries.length)}
          role="option"
          aria-selected={active === entries.length}
          onMouseDown={(event) => event.preventDefault()}
          onClick={showAll}
          onMouseMove={() => setSelection({ value, index: entries.length })}
          className={cn(
            "cursor-default break-words rounded-md px-2 py-2 text-sm text-muted-foreground",
            active === entries.length && "bg-accent text-accent-foreground",
          )}
        >
          {query && results.problem && entries.length === 0
            ? results.problem.message
            : query && results.settled && entries.length === 0
              ? "No matching names. Press Enter to search again."
              : results.total && results.total.count > entries.length
                ? `Show all ${count.format(results.total.count)}${results.total.exact ? "" : "+"} results for “${value.trim()}”`
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
