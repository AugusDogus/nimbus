import { useSubscription } from "@trpc/tanstack-react-query";

import type { FileDelta } from "@nimbus/api/file-events";

import { queryClient, trpc, trpcClient } from "@/lib/trpc";

import type { FileEntry } from "./types";

type UseFileSubscriptionOptions = {
  currentPath: string;
  includeStats: boolean;
  enabled: boolean;
};

export const useFileSubscription = ({
  currentPath,
  includeStats,
  enabled,
}: UseFileSubscriptionOptions) => {
  useSubscription(
    trpc.files.onChange.subscriptionOptions(
      currentPath ? { path: currentPath } : {},
      {
        enabled,
        onData: ({ data: delta }: { data: FileDelta }) => {
          if (delta.action === "removed") {
            const listKey = ["files.list", currentPath, includeStats];
            const prev = queryClient.getQueryData(listKey) as FileEntry[] | undefined;
            // Diagnostic fetch to compare list after rename.
            const debugPromise = trpcClient.files.list.query(
              currentPath ? { path: currentPath, includeStats } : { includeStats },
            );
            debugPromise
              .then((next) => {
                const removedName = delta.path.split("/").pop() ?? delta.path;
                const prevNames = prev?.map((entry) => entry.name) ?? [];
                const nextNames = next.map((entry) => entry.name);
                const removedWasInPrev = prevNames.includes(removedName);
                const nextMissingRemoved = !nextNames.includes(removedName);
                const sameCount = prevNames.length === nextNames.length;
                const renameCandidate = removedWasInPrev && nextMissingRemoved && sameCount;
                if (renameCandidate && prev) {
                  const newEntry = next.find((entry) => !prevNames.includes(entry.name));
                  if (newEntry) {
                    queryClient.setQueryData(listKey, (existing: FileEntry[] | undefined) => {
                      if (!existing) return existing;
                      return existing.map((entry) =>
                        entry.name === removedName
                          ? { ...entry, name: newEntry.name, path: newEntry.path }
                          : entry,
                      );
                    });
                    return;
                  }
                }
                // If not a rename, fall back to refetch.
                queryClient.invalidateQueries({ queryKey: listKey });
                queryClient.refetchQueries({ queryKey: listKey, exact: true });
              })
              .catch((error) => {
                queryClient.invalidateQueries({ queryKey: listKey });
                queryClient.refetchQueries({ queryKey: listKey, exact: true });
              });
          }
          queryClient.setQueryData(
            ["files.list", currentPath, includeStats],
            (prev: FileEntry[] | undefined) => {
              const next = [...(prev ?? [])];
              const index = next.findIndex((entry) => entry.path === delta.path);

              if (delta.action === "removed") {
                // Skip immediate removal; rename path will update after fetch.
                return next;
              }

              const updated = {
                name: delta.name,
                path: delta.path,
                type: delta.type,
                mtime: index >= 0 ? next[index].mtime ?? null : null,
                size: index >= 0 ? next[index].size ?? null : null,
              };

              if (index >= 0) {
                next[index] = updated;
                return next;
              }

              next.push(updated);
              return next;
            },
          );
        },
      },
    ),
  );
};
