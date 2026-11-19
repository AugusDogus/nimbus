import { useQuery } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import { trpcClient } from "@/lib/trpc";
import type { FileEntry } from "./types";

type Bookmarks = Awaited<ReturnType<typeof trpcClient.catalog.bookmarks.query>>;

/** What is starred now, as far as this page knows. */
export type StarredPaths =
  | { kind: "loading" }
  | { kind: "failed"; retry: () => void }
  | { kind: "ready"; paths: ReadonlySet<string> };

const starredPaths = (bookmarks: Bookmarks): ReadonlySet<string> =>
  new Set(
    bookmarks.filter((entry) => entry.starred).map((entry) => entry.path),
  );

/**
 * The starred paths, from the bookmarks the Recent and Starred pages read. Loaded only while
 * `enabled`, such as while a menu or a selection offers starring, so opening a folder costs no
 * request.
 */
export function useStarredPaths(enabled: boolean): StarredPaths {
  const query = useQuery({
    queryKey: ["catalog", "bookmarks"],
    queryFn: () => trpcClient.catalog.bookmarks.query(),
    select: starredPaths,
    enabled,
    // A menu or a selection reads the stars already loaded, without refreshing a list a page
    // shows; star changes made here reload them. Loading the first time, a failure shows at
    // once: using the control then says so and loads them again.
    refetchOnMount: false,
    retry: false,
  });
  if (query.data) return { kind: "ready", paths: query.data };
  if (query.isError)
    return { kind: "failed", retry: () => void query.refetch() };
  return { kind: "loading" };
}

/** A control that stars items: its label, whether it can be used, and what it does. */
export type StarControl = { label: string; disabled: boolean; run: () => void };

/**
 * The star control for `targets`. Starring several items stars them all, unless every one is
 * starred already: then it removes their stars. The label says which, and the action does
 * exactly that. Until the stars are known it cannot be used; if they cannot be loaded, it stars
 * nothing rather than guess, says so, and tries loading them again.
 */
export function starControl(
  targets: readonly FileEntry[],
  starred: StarredPaths,
  setStarred: (entries: readonly FileEntry[], starred: boolean) => unknown,
): StarControl {
  switch (starred.kind) {
    case "loading":
      return { label: "Star", disabled: true, run: () => {} };
    case "failed":
      return {
        label: "Star",
        disabled: false,
        run: () => {
          toast.error(
            "Nothing was starred or unstarred, because Nimbus could not check which items are already starred. Check your connection and try again.",
          );
          starred.retry();
        },
      };
    case "ready": {
      const adds = !targets.every((target) => starred.paths.has(target.path));
      return {
        label: adds ? "Star" : "Remove star",
        disabled: false,
        run: () => void setStarred(targets, adds),
      };
    }
  }
}
