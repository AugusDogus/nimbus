import { headers } from "next/headers";

import { createContext } from "@nimbus/api/context";
import { createCaller } from "@nimbus/api/routers";

import { auth } from "@/lib/auth";
import { api, HydrateClient } from "@/lib/trpc-server";
import { preferencesStore } from "@/server/preferences";

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

  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });

  let initialPrefs = null;
  let initialEntries = null;

  if (session) {
    const caller = createCaller(
      await createContext({
        auth,
        headers: requestHeaders,
        preferences: preferencesStore,
      }),
    );
    initialPrefs = await caller.prefs.get();
    const includeStats =
      initialPrefs.sortField === "modified" || initialPrefs.sortField === "size";
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
