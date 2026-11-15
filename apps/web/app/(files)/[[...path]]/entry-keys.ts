/** The parts of a keyboard event that decide a file browser command. */
export type KeyInput = {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  repeat: boolean;
  isComposing: boolean;
};

/**
 * - `select` moves focus and selects only the target.
 * - `extend` moves focus and selects the range from the anchor.
 * - `focus` moves focus without changing the selection.
 */
export type MoveMode = "select" | "extend" | "focus";

export type EntryCommand =
  | { type: "move"; index: number; mode: MoveMode }
  | { type: "open" }
  | { type: "preview" }
  | { type: "toggle" }
  | { type: "selectAll" }
  | { type: "clear" }
  | { type: "trash" }
  | { type: "rename" }
  | { type: "help" }
  | { type: "typeahead"; text: string };

export type KeyContext = {
  /** Focused entry index, or -1 before anything is focused. */
  index: number;
  count: number;
  /** Entries per visual row: 1 in list view. */
  columns: number;
  /** Entries per viewport, for PageUp and PageDown. */
  pageSize: number;
  isMac: boolean;
};

const clamp = (value: number, count: number) => Math.max(0, Math.min(count - 1, value));

function target(key: string, { index, count, columns, pageSize }: KeyContext): number | null {
  if (index < 0) return ["ArrowDown", "ArrowRight", "Home", "PageDown"].includes(key) ? 0 : ["ArrowUp", "ArrowLeft", "End", "PageUp"].includes(key) ? count - 1 : null;
  switch (key) {
    case "ArrowDown":
      return clamp(index + columns, count);
    case "ArrowUp":
      return clamp(index - columns, count);
    case "ArrowRight":
      return columns > 1 ? clamp(index + 1, count) : null;
    case "ArrowLeft":
      return columns > 1 ? clamp(index - 1, count) : null;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "PageDown":
      return clamp(index + Math.max(columns, pageSize - (pageSize % columns)), count);
    case "PageUp":
      return clamp(index - Math.max(columns, pageSize - (pageSize % columns)), count);
    default:
      return null;
  }
}

/** Map a key press inside the file collection to a command, or null to let it through. */
export function commandFor(event: KeyInput, context: KeyContext): EntryCommand | null {
  if (event.isComposing || context.count === 0) return null;
  const mod = context.isMac ? event.metaKey : event.ctrlKey;
  // Cross-platform modifiers this widget does not use belong to the browser or the OS.
  const foreign = context.isMac ? event.ctrlKey : event.metaKey;
  const moved = target(event.key, context);
  if (moved !== null && !event.altKey && !foreign)
    return { type: "move", index: moved, mode: event.shiftKey ? "extend" : mod ? "focus" : "select" };
  // Ctrl+Space toggles on every platform: Cmd+Space belongs to macOS.
  if (event.key === " " && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) return { type: "toggle" };
  if (event.altKey || foreign) return null;
  if (mod && !event.shiftKey && event.key.toLowerCase() === "a") return { type: "selectAll" };
  if (event.key === "Escape" && !mod && !event.shiftKey) return { type: "clear" };
  if (event.repeat) return null;
  if (event.key === "Enter" && !mod && !event.shiftKey) return { type: "open" };
  if (event.key === " ") return mod || event.shiftKey ? null : { type: "preview" };
  if (event.key === "Delete" || (event.key === "Backspace" && context.isMac && mod)) return { type: "trash" };
  if (event.key === "F2" && !mod && !event.shiftKey) return { type: "rename" };
  if (event.key === "?" && !mod) return { type: "help" };
  if (!mod && event.key.length === 1 && event.key !== " ") return { type: "typeahead", text: event.key };
  return null;
}

/**
 * Find the next entry whose name starts with `query`, searching after `from` and wrapping.
 * Repeating one character cycles through entries that start with it, as in desktop file managers.
 */
export function typeaheadMatch(names: readonly string[], from: number, query: string) {
  const needle = query.toLocaleLowerCase();
  const cycling = needle.length > 1 && [...needle].every((character) => character === needle[0]);
  const search = cycling ? needle.slice(0, 1) : needle;
  const start = cycling || needle.length === 1 ? from + 1 : Math.max(from, 0);
  for (let offset = 0; offset < names.length; offset++) {
    const index = (start + offset) % names.length;
    if (names[index]?.toLocaleLowerCase().startsWith(search)) return index;
  }
  return -1;
}
