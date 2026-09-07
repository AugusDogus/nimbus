import { useSubscription } from "@trpc/tanstack-react-query";
import { queryClient, trpc } from "@/lib/trpc";

type Options = { currentPath: string; includeStats: boolean; enabled: boolean };
export function useFileSubscription({ enabled }: Options) {
  useSubscription(
    trpc.files.onChange.subscriptionOptions(
      {},
      {
        enabled,
        onData() {
          void queryClient.invalidateQueries({ queryKey: ["files.list"] });
          void queryClient.invalidateQueries({ queryKey: ["files.storage"] });
          void queryClient.invalidateQueries({ queryKey: ["catalog"] });
        },
      },
    ),
  );
}
