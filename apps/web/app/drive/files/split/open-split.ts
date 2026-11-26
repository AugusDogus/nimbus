import type { UseNavigateResult } from "@tanstack/react-router";
import { SwipePanes } from "./swipe-panes";
import { queryClient } from "@/lib/trpc";
import { fileListQueryOptions } from "../use-file-list";
import { needsStats, prefsQueryOptions } from "../use-file-preferences";
import { SplitAddress } from "./split-address";
import { SplitMemory } from "./split-memory";

/**
 * Whether the folder at `path` still lists for this account. A listing this page already has
 * answers at once, and the pane refreshes it; otherwise the folder is asked for, and its
 * listing is then ready for the pane.
 */
async function opens(path: string, includeStats: boolean) {
  const cached = [includeStats, !includeStats].some(
    (stats) =>
      queryClient.getQueryData(fileListQueryOptions(path, stats).queryKey) !==
      undefined,
  );
  if (cached) return true;
  try {
    await queryClient.fetchQuery({
      ...fileListQueryOptions(path, includeStats),
      retry: false,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens a split view with `left` in the left pane, which stays active. The right pane shows
 * `right` when given ("Open in other pane"), otherwise the folder this browser last had there
 * while it still opens, otherwise `left` again. The ratio is the last one used.
 */
export async function openSplit({
  navigate,
  left,
  right,
}: {
  navigate: UseNavigateResult<string>;
  left: string;
  right: string | null;
}) {
  const memory = SplitMemory.read();
  const remembered = memory.right;
  const folder =
    right ??
    (remembered !== null &&
    remembered !== left &&
    (await opens(
      remembered,
      needsStats(
        memory.prefs ?? (await queryClient.ensureQueryData(prefsQueryOptions)),
      ),
    ))
      ? remembered
      : left);
  // Asked for by a person: one pane at a time, it opens with an entrance.
  SwipePanes.opening();
  await navigate({
    href: SplitAddress.href(left, {
      right: folder,
      active: "left",
      ratio: memory.ratio,
      collapsed: null,
    }),
  });
}
