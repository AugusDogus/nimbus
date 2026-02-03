import { useSubscription } from "@trpc/tanstack-react-query";

import type { FileDelta } from "@nimbus/api/file-events";

import { queryClient, trpc } from "@/lib/trpc";

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
          queryClient.setQueryData(
            ["files.list", currentPath, includeStats],
            (prev: FileEntry[] | undefined) => {
              const next = [...(prev ?? [])];
              const index = next.findIndex((entry) => entry.path === delta.path);

              if (delta.action === "removed") {
                if (index >= 0) {
                  next.splice(index, 1);
                }
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
