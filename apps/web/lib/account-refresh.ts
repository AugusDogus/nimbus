import { queryClient, trpc } from "./trpc";

/** Reloads the account overview after a sign-in method or session changes. */
export const refreshAccount = () =>
  queryClient.invalidateQueries(trpc.account.overview.queryFilter());
