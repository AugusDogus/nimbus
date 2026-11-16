import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/_files/admin")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/admin", replace: true });
  },
});
