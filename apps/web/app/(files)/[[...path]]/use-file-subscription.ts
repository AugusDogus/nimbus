import { useSubscription } from "@trpc/tanstack-react-query";
import { useEffect, useState } from "react";
import { queryClient, trpc } from "@/lib/trpc";
import { coalesce } from "@/lib/coalesce";

// Uploads and bulk actions emit an event per item. Refetching a large folder for each one would
// keep cancelling the previous refetch, so refresh at most once per interval and let refetches finish.
const refreshIntervalMs = 750;

type Options = { currentPath: string; includeStats: boolean; enabled: boolean };
export function useFileSubscription({ enabled }: Options) {
  const [refresh] = useState(() =>
    coalesce(() => {
      const options = { cancelRefetch: false } as const;
      void queryClient.invalidateQueries({ queryKey: ["files.list"] }, options);
      void queryClient.invalidateQueries(
        { queryKey: ["files.storage"] },
        options,
      );
      void queryClient.invalidateQueries({ queryKey: ["catalog"] }, options);
    }, refreshIntervalMs),
  );
  useEffect(() => () => refresh.cancel(), [refresh]);
  useSubscription(
    trpc.files.onChange.subscriptionOptions(
      {},
      {
        enabled,
        onData: refresh,
      },
    ),
  );
}
