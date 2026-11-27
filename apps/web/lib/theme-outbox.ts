import { ThemePreferences, type ThemeChange } from "./theme-preferences";
import { ThemeStore } from "./theme-store";
import type { ThemeResult } from "./vscode-theme";

/**
 * Color theme changes this browser made that the server has not answered yet. A change is
 * applied here and written to the outbox in the same moment it is made, before any request, so
 * leaving the page straight after loses nothing: the next load sends what the outbox still holds
 * (`ColorThemeSync.reconcile`). The server checks each change fully when it receives it.
 */
const outboxKey = "nimbus-themes-outbox";
export type StagedChange = {
  id: string;
  change: ThemeChange;
  /** This browser's copy before the change, to restore if the server refuses it. */
  previous: ThemePreferences | null;
};

const kinds = new Set(["install", "select", "remove", "reset"]);

function read(): StagedChange[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(outboxKey) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is StagedChange =>
        typeof item === "object" &&
        item !== null &&
        typeof Reflect.get(item, "id") === "string" &&
        kinds.has(
          String(Reflect.get(Reflect.get(item, "change") ?? {}, "kind")),
        ),
    );
  } catch {
    return [];
  }
}

function write(pending: StagedChange[]) {
  try {
    if (pending.length === 0) localStorage.removeItem(outboxKey);
    else localStorage.setItem(outboxKey, JSON.stringify(pending));
  } catch {
    // Without storage a change cut off by navigation is lost; the next load shows the server's.
  }
}

/** Applies `change` to this browser's copy and queues it for the server, synchronously. */
function stage(change: ThemeChange): ThemeResult<StagedChange> {
  const previous = ThemeStore.current();
  // An unreadable copy can still be reset: the server's answer replaces it.
  if (!previous.ok && change.kind !== "reset") return previous;
  const next = ThemePreferences.apply(
    previous.ok ? previous.value : ThemePreferences.empty,
    change,
  );
  if (!next.ok) return next;
  ThemeStore.replace(next.value);
  const staged = {
    id: crypto.randomUUID(),
    change,
    previous: previous.ok ? previous.value : null,
  };
  // The previous copy is only needed while this page waits for the answer.
  write([...read(), { ...staged, previous: null }]);
  return { ok: true, value: staged };
}

export const ThemeOutbox = {
  stage,
  pending: read,
  settle: (id: string) => write(read().filter((pending) => pending.id !== id)),
} as const;
