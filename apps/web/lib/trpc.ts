import type { WebRouter } from "@/server/web-router";
import {
  createTRPCClient,
  httpBatchLink,
  httpSubscriptionLink,
  loggerLink,
  splitLink,
} from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";

import { createQueryClient } from "./query-client";

export const queryClient = createQueryClient();

const trpcClient = createTRPCClient<WebRouter>({
  links: [
    loggerLink({
      enabled: (op) =>
        import.meta.env.DEV ||
        (op.direction === "down" && op.result instanceof Error),
    }),
    splitLink({
      condition: (op) => op.type === "subscription",
      true: httpSubscriptionLink({
        url: "/api/trpc",
      }),
      false: httpBatchLink({
        url: "/api/trpc",
      }),
    }),
  ],
});

export const trpc = createTRPCOptionsProxy<WebRouter>({
  client: trpcClient,
  queryClient,
});

export { trpcClient };
