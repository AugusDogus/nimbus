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
 *
 * It opens at once, without waiting to hear whether the remembered folder still opens: that is
 * asked meanwhile, and a folder that no longer does gives way to `left` in the split it opened.
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
    right ?? (remembered !== null && remembered !== left ? remembered : left);
  const show = (path: string, replace: boolean) =>
    navigate({
      href: SplitAddress.href(left, {
        right: path,
        active: "left",
        ratio: memory.ratio,
        collapsed: null,
      }),
      replace,
    });
  // Asked for by a person: one pane at a time, it opens with an entrance.
  SwipePanes.opening();
  const shown = show(folder, false);
  if (right === null && folder !== left) {
    const includeStats = needsStats(
      memory.prefs ?? (await queryClient.ensureQueryData(prefsQueryOptions)),
    );
    if (!(await opens(folder, includeStats))) {
      const now = SplitAddress.here();
      if (now?.left === left && now.layout.right === folder)
        await show(left, true);
    }
  }
  await shown;
}
