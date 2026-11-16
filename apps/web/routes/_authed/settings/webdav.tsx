import { createFileRoute } from "@tanstack/react-router";
import { WebDavSettings } from "@/app/settings/webdav/webdav-settings";

export const Route = createFileRoute("/_authed/settings/webdav")({
  component: function WebDavPage() {
    const { session } = Route.useRouteContext();
    return <WebDavSettings email={session.user.email} />;
  },
});
