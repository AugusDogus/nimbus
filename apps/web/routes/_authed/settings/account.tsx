import { createFileRoute } from "@tanstack/react-router";
import { AccountPage } from "@/app/settings/account/account-page";
import { trpc } from "@/lib/trpc";

export const Route = createFileRoute("/_authed/settings/account")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(trpc.account.overview.queryOptions()),
  component: AccountPage,
});
