import type { UserPreferences } from "@nimbus/api/context";
import type { FileEntry } from "./types";

/** `entries` in the order a folder listing shows them under `prefs`, folders first when grouped. */
export function sortEntries<T extends FileEntry>(
  entries: readonly T[],
  prefs: Pick<UserPreferences, "sortField" | "sortDirection" | "groupByType">,
): T[] {
  return [...entries].sort((a, b) => {
    // When grouping, always sort folders first
    if (prefs.groupByType && a.type !== b.type) {
      return a.type === "dir" ? -1 : 1;
    }

    let comparison = 0;
    switch (prefs.sortField) {
      case "name":
        comparison = a.name.localeCompare(b.name);
        break;
      case "type":
        comparison = a.type.localeCompare(b.type);
        break;
      case "modified":
        comparison = (a.mtime ?? 0) - (b.mtime ?? 0);
        break;
      case "size":
        comparison = (a.size ?? 0) - (b.size ?? 0);
        break;
      default:
        comparison = 0;
    }

    return prefs.sortDirection === "desc" ? -comparison : comparison;
  });
}
