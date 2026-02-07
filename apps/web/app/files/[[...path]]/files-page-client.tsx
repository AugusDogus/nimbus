"use client";

import { Folder, HardDrive } from "lucide-react";
import { useParams } from "next/navigation";
import { useMemo } from "react";

import { useSession } from "@/lib/auth-client";

import { FileBreadcrumbs } from "./breadcrumbs";
import { EntriesView } from "./entries-view";
import { FiltersRow } from "./filters-row";
import { LoadingSkeleton } from "./loading-skeleton";
import { useFileActions } from "./use-file-actions";
import { useFileList } from "./use-file-list";
import { useFilePreferences } from "./use-file-preferences";
import { useFileSubscription } from "./use-file-subscription";

type SessionData = ReturnType<typeof useSession>["data"];

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

type FilesPageClientProps = {
  pathSegments: string[];
  initialSession: SessionData | null;
  initialPrefs: ReturnType<typeof useFilePreferences>["prefs"] | null;
  initialEntries: ReturnType<typeof useFileList>["entries"] | null;
};

export function FilesPageClient({
  pathSegments,
  initialSession,
  initialPrefs,
  initialEntries,
}: FilesPageClientProps) {
  const params = useParams<Params>();
  const paramSegments = useMemo(
    () => normalizePathSegments(params?.path),
    [params?.path],
  );
  const effectiveSegments = paramSegments.length > 0 ? paramSegments : pathSegments;
  const currentPath = effectiveSegments.join("/");
  const { data: sessionData } = useSession();
  const session = sessionData ?? initialSession;
  const isAuthed = Boolean(session);

  const { prefs, updatePreferences } = useFilePreferences(isAuthed, initialPrefs ?? undefined);
  const view = prefs.view;

  const includeStats =
    prefs.sortField === "modified" || prefs.sortField === "size";
  const { entries, listQuery } = useFileList({
    currentPath,
    includeStats,
    enabled: isAuthed,
    initialData: initialEntries ?? undefined,
  });
  const actions = useFileActions({ currentPath, includeStats });

  useFileSubscription({
    currentPath,
    includeStats,
    enabled: isAuthed,
  });

  const sortedEntries = useMemo(() => {
    const sorted = [...entries].sort((a, b) => {
      // When grouping, always sort folders first
      if (prefs.groupByType && a.type !== b.type) {
        return a.type === "dir" ? -1 : 1;
      }

      let comparison = 0;
      switch (prefs.sortField) {
        case "name":
          comparison = a.name.localeCompare(b.name);
          break;
        case "type":
          comparison = a.type.localeCompare(b.type);
          break;
        case "modified":
          comparison = (a.mtime ?? 0) - (b.mtime ?? 0);
          break;
        case "size":
          comparison = (a.size ?? 0) - (b.size ?? 0);
          break;
        default:
          comparison = 0;
      }

      return prefs.sortDirection === "desc" ? -comparison : comparison;
    });
    return sorted;
  }, [entries, prefs.groupByType, prefs.sortDirection, prefs.sortField]);

  const folders = prefs.groupByType
    ? sortedEntries.filter((e) => e.type === "dir")
    : [];
  const files = prefs.groupByType
    ? sortedEntries.filter((e) => e.type !== "dir")
    : [];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <FileBreadcrumbs pathSegments={effectiveSegments} />
        <FiltersRow
          prefs={prefs}
          view={view}
          updatePreferences={updatePreferences}
        />
      </div>

      {!session ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="mb-6 flex size-20 items-center justify-center rounded-full bg-primary/10">
            <HardDrive className="size-10 text-primary" />
          </div>
          <h2 className="text-balance text-xl font-semibold">
            Welcome to Nimbus Drive
          </h2>
          <p className="text-pretty mt-2 max-w-md text-sm text-muted-foreground">
            Sign in to access your files, photos, and documents from
            anywhere.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {listQuery.isLoading ? (
            <LoadingSkeleton view={view} />
          ) : listQuery.isError ? (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
              {listQuery.error instanceof Error
                ? listQuery.error.message
                : "Failed to load files."}
            </div>
          ) : entries.length > 0 ? (
            <EntriesView
              view={view}
              groupByType={prefs.groupByType}
              folders={folders}
              files={files}
              sortedEntries={sortedEntries}
              actions={actions}
            />
          ) : (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="mb-4 flex size-16 items-center justify-center rounded-full bg-muted">
                <Folder className="size-8 text-muted-foreground" />
              </div>
              <h3 className="text-balance text-lg font-medium">
                This folder is empty
              </h3>
              <p className="text-pretty mt-1 text-sm text-muted-foreground">
                Drop files here or use the New button to add content
              </p>
            </div>
          )}
        </div>
      )}
    </>
  );
}
