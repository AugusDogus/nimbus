import { createFileRoute } from "@tanstack/react-router";
import { PairPage } from "@/app/pair/pair-page";
import { SearchParams } from "@/client/search-params";

/** Approve a device that shows a pairing code: /pair?code=ABCD-EFGH from its QR code. */
export const Route = createFileRoute("/_authed/pair")({
  validateSearch: (search): { code?: string } => ({
    code: SearchParams.string(search, "code"),
  }),
  component: function Pair() {
    const { code } = Route.useSearch();
    const { session } = Route.useRouteContext();
    return <PairPage initialCode={code ?? ""} email={session.user.email} />;
  },
});
