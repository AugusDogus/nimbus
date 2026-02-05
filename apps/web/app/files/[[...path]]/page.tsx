"use client";

import { Folder, HardDrive, Search } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo } from "react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { signOut, useSession } from "@/lib/auth-client";
import { AppSidebar } from "./app-sidebar";
import { FileBreadcrumbs } from "./breadcrumbs";
import { EntriesView } from "./entries-view";
import { FiltersRow } from "./filters-row";
import { LoadingSkeleton } from "./loading-skeleton";
import { useFileList } from "./use-file-list";
import { useFilePreferences } from "./use-file-preferences";
import { useFileStorage } from "./use-file-storage";
import { useFileSubscription } from "./use-file-subscription";

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

export default function FilesPage() {
  const params = useParams<Params>();
  const pathSegments = useMemo(
    () => normalizePathSegments(params?.path),
    [params?.path],
  );
  const currentPath = pathSegments.join("/");

  const { data, isPending } = useSession();

  const { prefs, updatePreferences } = useFilePreferences(Boolean(data));
  const view = prefs.view;

  const includeStats =
    prefs.sortField === "modified" || prefs.sortField === "size";
  const { entries, listQuery } = useFileList({
    currentPath,
    includeStats,
    enabled: Boolean(data),
  });

  useFileSubscription({
    currentPath,
    includeStats,
    enabled: Boolean(data),
  });
  const storage = useFileStorage(Boolean(data));

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
    <SidebarProvider>
      <AppSidebar storage={storage} />
      <SidebarInset>
        {/* Header */}
        <header className="sticky top-0 z-10 flex h-16 items-center justify-between gap-4 border-b bg-background/80 px-4 backdrop-blur-sm">
          <div className="flex flex-1 items-center gap-4">
            <SidebarTrigger />
            <div className="relative max-w-md flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search in Drive"
                className="h-10 rounded-full bg-muted pl-10"
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            {data ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="relative size-9 rounded-full">
                    <Avatar>
                      <AvatarFallback className="bg-primary text-primary-foreground">
                        {data.user.name?.charAt(0).toUpperCase() ||
                          data.user.email?.charAt(0).toUpperCase() ||
                          "U"}
                      </AvatarFallback>
                    </Avatar>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>
                    <div className="flex flex-col space-y-1">
                      {data.user.name && (
                        <p className="text-sm font-medium">{data.user.name}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {data.user.email}
                      </p>
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => signOut()}
                    variant="destructive"
                  >
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button size="sm" asChild>
                <Link href="/login">Sign in</Link>
              </Button>
            )}
          </div>
        </header>

        <main className="flex-1 overflow-x-hidden p-2 md:p-4 lg:p-6">
          {/* Breadcrumbs and filters */}
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <FileBreadcrumbs pathSegments={pathSegments} />
            <FiltersRow
              prefs={prefs}
              view={view}
              updatePreferences={updatePreferences}
            />
          </div>

          {/* Content */}
          {isPending ? (
            <LoadingSkeleton view={view} />
          ) : data ? (
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
          ) : (
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
              <Button asChild className="mt-6">
                <Link href="/login">Sign in to get started</Link>
              </Button>
            </div>
          )}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
