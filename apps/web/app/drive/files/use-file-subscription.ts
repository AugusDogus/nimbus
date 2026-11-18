import { useSubscription } from "@trpc/tanstack-react-query";
import { useEffect, useState } from "react";
import { queryClient, trpc } from "@/lib/trpc";
import { coalesce } from "@/lib/coalesce";
import { FileUpdates } from "./file-updates";

// Uploads and bulk actions emit an event per item. Refetching a large folder for each one would
// keep cancelling the previous refetch, so refresh at most once per interval and let refetches finish.
const refreshIntervalMs = 750;

type Options = { currentPath: string; includeStats: boolean; enabled: boolean };
export function useFileSubscription({ enabled }: Options) {
  const [updates] = useState(() => {
    const collected = FileUpdates.collector((keys, resync) => {
      // Ordinary bursts let a running refetch finish. After a resync its answer may predate the
      // dropped changes, so it is replaced.
      const options = { cancelRefetch: resync };
      for (const key of keys)
        void queryClient.invalidateQueries({ queryKey: [key] }, options);
    });
    const flush = coalesce(collected.flush, refreshIntervalMs);
    return { collected, flush };
  });
  useEffect(() => () => updates.flush.cancel(), [updates]);
  useSubscription(
    trpc.files.onChange.subscriptionOptions(
      {},
      {
        enabled,
        onData: (update) => {
          // A resync (the server dropped changes) refreshes more, still once per interval.
          updates.collected.add(update.data);
          updates.flush();
        },
      },
    ),
  );
}
