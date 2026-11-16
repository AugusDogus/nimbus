import { createFileRoute } from "@tanstack/react-router";
import { LibraryPage } from "@/app/drive/library-page";

export const Route = createFileRoute("/_authed/_files/recent")({
  component: () => <LibraryPage kind="recent" />,
});
