import { createFileRoute } from "@tanstack/react-router";
import { FilesPageClient } from "@/app/drive/files/files-page-client";
import { preloadFolder } from "@/app/drive/files/folder-route";

export const Route = createFileRoute("/_authed/_files/")({
  loader: ({ context }) => preloadFolder(context.queryClient, ""),
  component: () => <FilesPageClient />,
});
