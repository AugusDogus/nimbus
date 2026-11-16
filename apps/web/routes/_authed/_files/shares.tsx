import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/_files/shares")({
  beforeLoad: () => {
    throw redirect({ to: "/shared", search: { tab: "links" }, replace: true });
  },
});
