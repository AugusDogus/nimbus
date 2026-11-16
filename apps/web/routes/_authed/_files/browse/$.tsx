import { createFileRoute } from "@tanstack/react-router";
import { FilesPageClient } from "@/app/drive/files/files-page-client";
import { preloadFolder } from "@/app/drive/files/folder-route";
import { FolderPath } from "@/app/drive/files/folder-path";

export const Route = createFileRoute("/_authed/_files/browse/$")({
  loader: ({ context, params }) =>
    preloadFolder(context.queryClient, FolderPath.fromSplat(params._splat)),
  component: () => <FilesPageClient />,
});
