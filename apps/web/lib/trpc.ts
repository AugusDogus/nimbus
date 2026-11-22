import type { WebRouter } from "@/server/web-router";
import {
  createTRPCClient,
  httpBatchLink,
  httpSubscriptionLink,
  loggerLink,
  splitLink,
} from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";

import { CodeLoad } from "./code-load";
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
        // Each answer names the build the server runs; a newer one than this page's means
        // Nimbus was updated while the page was open.
        fetch: async (url, init) => {
          const response = await fetch(url, init);
          CodeLoad.checkBuild(response.headers.get("Nimbus-Build"));
          return response;
        },
      }),
    }),
  ],
});

export const trpc = createTRPCOptionsProxy<WebRouter>({
  client: trpcClient,
  queryClient,
});

export { trpcClient };
