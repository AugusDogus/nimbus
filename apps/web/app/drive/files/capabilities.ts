import { queryOptions } from "@tanstack/react-query";
import { trpcClient } from "@/lib/trpc";

/** What the caller may do in the folder at `path`; the shell and the folder page share it. */
export const capabilitiesQueryOptions = (path: string) =>
  queryOptions({
    queryKey: ["capabilities", path],
    queryFn: () => trpcClient.access.capabilities.query({ path }),
  });
