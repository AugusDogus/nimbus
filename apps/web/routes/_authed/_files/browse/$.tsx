import { createFileRoute } from "@tanstack/react-router";
import { FilesPageClient } from "@/app/drive/files/files-page-client";
import { preloadFolder } from "@/app/drive/files/folder-route";
import { FolderPath } from "@/app/drive/files/folder-path";
import { validateSplitSearch } from "@/app/drive/files/split-search";

export const Route = createFileRoute("/_authed/_files/browse/$")({
  // A split view keeps its second folder in the search params (see `SplitLayout`).
  validateSearch: validateSplitSearch,
  loader: ({ context, params }) =>
    preloadFolder(context.queryClient, FolderPath.fromSplat(params._splat)),
  component: () => <FilesPageClient />,
});
