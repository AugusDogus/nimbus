import { notFound } from "next/navigation";
import { TRPCError } from "@trpc/server";
import { api, HydrateClient } from "@/lib/trpc-server";
import { getCaller, getInitialPrefs, getSession } from "@/server/files-data";
import { decodeFilePathSegments } from "@/lib/file-route";

import { FilesPageClient } from "./files-page-client";

type Params = {
  path?: string[] | string;
};

export default async function FilesPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const resolvedParams = await params;
  const pathSegments = decodeFilePathSegments(resolvedParams.path);
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
        fetchedPrefs.sortField === "modified" ||
        fetchedPrefs.sortField === "size";
      try {
        initialEntries = await caller.files.list({
          path: currentPath || undefined,
          includeStats,
        });
      } catch (error) {
        if (error instanceof TRPCError && error.code === "NOT_FOUND")
          notFound();
        throw error;
      }
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
