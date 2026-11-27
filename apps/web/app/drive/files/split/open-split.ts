import type { UseNavigateResult } from "@tanstack/react-router";
import { SwipePanes } from "./swipe-panes";
import { queryClient } from "@/lib/trpc";
import { fileListQueryOptions } from "../use-file-list";
import { needsStats, prefsQueryOptions } from "../use-file-preferences";
import { SplitAddress } from "./split-address";
import { SplitMemory } from "./split-memory";
import type { SplitLayout } from "../split-layout";

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
 * The split a person asks for beside `left`, with `left` active: the right pane shows `right`
 * when given ("Open in other pane"), otherwise the folder this browser last had there, otherwise
 * `left` again. The ratio is the last one used.
 */
export function plannedSplit(left: string, right: string | null): SplitLayout {
  const memory = SplitMemory.read();
  const remembered = memory.right;
  return {
    right:
      right ?? (remembered !== null && remembered !== left ? remembered : left),
    active: "left",
    ratio: memory.ratio,
    collapsed: null,
  };
}

/**
 * Opens a split view with `left` in the left pane, as `plannedSplit` plans it, or as `planned`
 * when a press has shown it already (see `SplitPress`); `entrance` false then, as it has made its
 * own.
 *
 * It opens at once, without waiting to hear whether the remembered folder still opens: that is
 * asked meanwhile, and a folder that no longer does gives way to `left` in the split it opened.
 */
export async function openSplit({
  navigate,
  left,
  right,
  planned = plannedSplit(left, right),
  entrance = true,
}: {
  navigate: UseNavigateResult<string>;
  left: string;
  right: string | null;
  planned?: SplitLayout;
  entrance?: boolean;
}) {
  const folder = planned.right;
  const show = (path: string, replace: boolean) =>
    navigate({
      href: SplitAddress.href(left, { ...planned, right: path }),
      replace,
    });
  // Asked for by a person: one pane at a time, it opens with an entrance.
  if (entrance) SwipePanes.opening();
  const shown = show(folder, false);
  if (right === null && folder !== left) {
    const prefs = SplitMemory.read().prefs;
    const includeStats = needsStats(
      prefs ?? (await queryClient.ensureQueryData(prefsQueryOptions)),
    );
    if (!(await opens(folder, includeStats))) {
      const now = SplitAddress.here();
      if (now?.left === left && now.layout.right === folder)
        await show(left, true);
    }
  }
  await shown;
}
