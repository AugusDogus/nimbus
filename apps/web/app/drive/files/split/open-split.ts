import type { UseNavigateResult } from "@tanstack/react-router";
import { CodeLoad } from "@/lib/code-load";
import { queryClient } from "@/lib/trpc";
import { fileListQueryOptions } from "../use-file-list";
import { needsStats, prefsQueryOptions } from "../use-file-preferences";
import { SplitAddress } from "./split-address";
import { SplitMemory } from "./split-memory";

/** Whether the folder at `path` still lists for this account. Its listing is then ready too. */
async function opens(path: string, includeStats: boolean) {
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
  // Starts now, beside the checks below. A load that fails shows the code load notice, and the
  // page stays as it is.
  const view = CodeLoad.load(() => import("./split-view")).then(
    () => true,
    (error: unknown) => {
      CodeLoad.failed(error);
      return false;
    },
  );
  const memory = SplitMemory.read();
  const prefs =
    memory.prefs ?? (await queryClient.ensureQueryData(prefsQueryOptions));
  const remembered = memory.right;
  const folder =
    right ??
    (remembered !== null && (await opens(remembered, needsStats(prefs)))
      ? remembered
      : left);
  // The view's code arrives before the address changes, so the page never shows nothing.
  if (!(await view)) return;
  await navigate({
    href: SplitAddress.href(left, {
      right: folder,
      active: "left",
      ratio: memory.ratio,
      collapsed: null,
    }),
  });
}
