import { api, HydrateClient } from "@/lib/trpc-server";
import { getCaller, getInitialPrefs, getSession } from "@/server/files-data";

import { FilesPageClient } from "./files-page-client";

type Params = {
  path?: string[] | string;
};

const normalizePathSegments = (pathParam: Params["path"]) => {
  if (!pathParam) {
    return [];
  }
  if (Array.isArray(pathParam)) {
    return pathParam;
  }
  return [pathParam];
};

export default async function FilesPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const resolvedParams = await params;
  const pathSegments = normalizePathSegments(resolvedParams.path);
  const currentPath = pathSegments.join("/");

  const session = await getSession();
  let initialPrefs = null;
  let initialEntries = null;

  if (session) {
    const caller = await getCaller();
    const fetchedPrefs = await getInitialPrefs();
    if (fetchedPrefs) {
      initialPrefs = fetchedPrefs;
      const includeStats =
        fetchedPrefs.sortField === "modified" || fetchedPrefs.sortField === "size";
      initialEntries = await caller.files.list({
        path: currentPath || undefined,
        includeStats,
      });
      await api.prefs.get.prefetch();
      await api.files.list.prefetch({
        path: currentPath || undefined,
        includeStats,
      });
    }
  }

  return (
    <HydrateClient>
      <FilesPageClient
        pathSegments={pathSegments}
        initialSession={session ?? null}
        initialPrefs={initialPrefs}
        initialEntries={initialEntries}
      />
    </HydrateClient>
  );
}
