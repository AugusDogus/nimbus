import type { UserPreferences } from "@nimbus/api/context";
import { SplitLayout } from "../split-layout";

/**
 * The split view this browser used last: the right pane's folder, the width ratio, and the
 * right pane's sort and view. Opening a split starts from it; an address with split params wins.
 */
export type SplitMemory = {
  right: string | null;
  ratio: number;
  prefs: UserPreferences | null;
};

const storageKey = "nimbus.split-view";
const empty: SplitMemory = {
  right: null,
  ratio: SplitLayout.ratioBounds.initial,
  prefs: null,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function prefsOf(value: unknown): UserPreferences | null {
  if (!isRecord(value)) return null;
  const { view, sortField, sortDirection, groupByType } = value;
  if (view !== "list" && view !== "grid") return null;
  if (
    sortField !== "name" &&
    sortField !== "type" &&
    sortField !== "modified" &&
    sortField !== "size"
  )
    return null;
  if (sortDirection !== "asc" && sortDirection !== "desc") return null;
  if (typeof groupByType !== "boolean") return null;
  return { view, sortField, sortDirection, groupByType };
}

/** What was stored, or nothing usable: storage can be blocked, cleared, or hold another shape. */
function read(): SplitMemory {
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem(storageKey) ?? "null",
    );
    if (!isRecord(stored)) return empty;
    const layout = SplitLayout.parse({
      right: typeof stored.right === "string" ? stored.right || "/" : undefined,
      ratio:
        typeof stored.ratio === "number" ? String(stored.ratio) : undefined,
    });
    return {
      right: layout?.right ?? null,
      ratio: layout?.ratio ?? empty.ratio,
      prefs: prefsOf(stored.prefs),
    };
  } catch {
    return empty;
  }
}

/** Remembers `change` on top of what is stored. A browser that refuses storage forgets it. */
function write(change: Partial<SplitMemory>) {
  try {
    localStorage.setItem(storageKey, JSON.stringify({ ...read(), ...change }));
  } catch {
    // Without storage the split view still works; it opens with defaults next time.
  }
}

export const SplitMemory = { read, write } as const;
