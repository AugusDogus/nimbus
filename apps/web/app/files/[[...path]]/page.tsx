"use client";

import {
    ArrowDownAZ,
    ArrowUpAZ,
    Calendar,
    Clock,
    Cloud,
    FileText,
    Folder,
    Grid2X2,
    HardDrive,
    List,
    Plus,
    Search,
    Star,
    Trash2,
    Users,
    Weight,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Fragment, useMemo } from "react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
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
import { Progress } from "@/components/ui/progress";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarHeader,
    SidebarInset,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarProvider,
    SidebarTrigger,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { signOut, useSession } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
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

const navItems = [
  { icon: HardDrive, label: "My Drive", href: "/files", isActive: true },
  { icon: Users, label: "Shared with me", href: "", disabled: true },
  { icon: Clock, label: "Recent", href: "", disabled: true },
  { icon: Star, label: "Starred", href: "", disabled: true },
  { icon: Trash2, label: "Trash", href: "", disabled: true },
];

type StorageSummary = {
  usedBytes: number | null;
  label: string;
  progressValue: number;
  isLoading: boolean;
};

function AppSidebar({ storage }: { storage: StorageSummary }) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Nimbus">
              <Link href="/files">
                <Cloud className="text-primary" />
                <span className="font-semibold">Nimbus</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="New"
                  className="bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
                >
                  <Plus />
                  <span>New</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.label}>
                  <SidebarMenuButton
                    asChild={!item.disabled}
                    isActive={item.isActive}
                    tooltip={item.label}
                    className={cn(
                      item.disabled &&
                        "cursor-not-allowed text-muted-foreground/60 hover:bg-transparent hover:text-muted-foreground/60",
                    )}
                  >
                    {item.disabled ? (
                      <span className="flex items-center gap-2">
                        <item.icon className="size-5" />
                        <span>{item.label}</span>
                      </span>
                    ) : (
                      <Link href={item.href}>
                        <item.icon className="size-5" />
                        <span>{item.label}</span>
                      </Link>
                    )}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="p-4">
        <div className="space-y-2 group-data-[collapsible=icon]:hidden">
          <p className="text-xs text-muted-foreground">Storage</p>
          <Progress
            value={storage.progressValue}
            className="h-1.5"
            aria-valuetext={storage.label}
          />
          <p className="text-xs text-muted-foreground">{storage.label}</p>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

function LoadingSkeleton({ view }: { view: "list" | "grid" }) {
  if (view === "grid") {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {Array.from({ length: 12 }).map((_, i) => (
          <div
            key={i}
            className="flex flex-col gap-2 rounded-xl border bg-card p-3 sm:gap-3 sm:p-4"
          >
            <Skeleton className="h-16 w-full rounded-lg sm:h-24" />
            <Skeleton className="h-3 w-3/4 sm:h-4" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 rounded-lg px-4 py-3">
          <Skeleton className="size-6 rounded" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-24" />
        </div>
      ))}
    </div>
  );
}

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

        <main className="flex-1 overflow-x-hidden p-4 lg:p-6">
          {/* Breadcrumbs */}
          <Breadcrumb className="mb-4">
            <BreadcrumbList>
              <BreadcrumbItem>
                {pathSegments.length === 0 ? (
                  <BreadcrumbPage>My Drive</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link href="/files">My Drive</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {pathSegments.map((segment, index) => {
                const crumbPath = pathSegments.slice(0, index + 1).join("/");
                const isLast = index === pathSegments.length - 1;
                const label = (() => {
                  try {
                    return decodeURIComponent(segment);
                  } catch {
                    return segment;
                  }
                })();
                return (
                  <Fragment key={crumbPath}>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      {isLast ? (
                        <BreadcrumbPage>{label}</BreadcrumbPage>
                      ) : (
                        <BreadcrumbLink asChild>
                          <Link href={`/files/${crumbPath}`}>{label}</Link>
                        </BreadcrumbLink>
                      )}
                    </BreadcrumbItem>
                  </Fragment>
                );
              })}
            </BreadcrumbList>
          </Breadcrumb>

          {/* Filters row */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Select
              value={`${prefs.sortField}-${prefs.sortDirection}`}
              onValueChange={(value) => {
                const [field, direction] = value.split("-") as [
                  typeof prefs.sortField,
                  typeof prefs.sortDirection,
                ];
                updatePreferences({ sortField: field, sortDirection: direction });
              }}
            >
              <SelectTrigger className="w-auto min-w-[140px]">
                <SelectValue />
              </SelectTrigger>
                <SelectContent>
                  <SelectItem value="name-asc">
                    <ArrowDownAZ className="size-4" />
                    Name (A to Z)
                  </SelectItem>
                  <SelectItem value="name-desc">
                    <ArrowUpAZ className="size-4" />
                    Name (Z to A)
                  </SelectItem>
                  <SelectItem value="modified-desc">
                    <Calendar className="size-4" />
                    Modified (Newest)
                  </SelectItem>
                  <SelectItem value="modified-asc">
                    <Calendar className="size-4" />
                    Modified (Oldest)
                  </SelectItem>
                  <SelectItem value="size-desc">
                    <Weight className="size-4" />
                    Size (Largest)
                  </SelectItem>
                  <SelectItem value="size-asc">
                    <Weight className="size-4" />
                    Size (Smallest)
                  </SelectItem>
                  <SelectItem value="type-asc">
                    <FileText className="size-4" />
                    Type (A to Z)
                  </SelectItem>
                  <SelectItem value="type-desc">
                    <FileText className="size-4" />
                    Type (Z to A)
                  </SelectItem>
                </SelectContent>
              </Select>

            <Button
              variant={prefs.groupByType ? "secondary" : "outline"}
              size="sm"
              onClick={() => updatePreferences({ groupByType: !prefs.groupByType })}
            >
              Group
            </Button>

            <ToggleGroup
              type="single"
              value={view}
              onValueChange={(value) => {
                if (value === "grid" || value === "list") {
                  updatePreferences({ view: value });
                }
              }}
              variant="outline"
            >
              <ToggleGroupItem value="list" aria-label="List view">
                <List className="size-4" />
              </ToggleGroupItem>
              <ToggleGroupItem value="grid" aria-label="Grid view">
                <Grid2X2 className="size-4" />
              </ToggleGroupItem>
            </ToggleGroup>
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
                prefs.groupByType ? (
                  <>
                    {/* Folders section */}
                  {folders.length > 0 && (
                      <section>
                        <h2 className="mb-3 text-sm font-medium text-muted-foreground">
                          Folders
                        </h2>
                        <div
                          className={cn(
                            view === "list"
                              ? "space-y-1"
                              : "grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6",
                          )}
                        >
                          {folders.map((entry) =>
                            view === "list" ? (
                              <Link
                                key={entry.path}
                                href={`/files/${entry.path}`}
                                className="flex items-center gap-4 rounded-lg px-4 py-3 hover:bg-accent"
                              >
                                <Folder className="size-6 fill-muted text-muted-foreground" />
                                <span className="flex-1 truncate text-sm font-medium">
                                  {entry.name}
                                </span>
                              </Link>
                            ) : (
                              <Link
                                key={entry.path}
                                href={`/files/${entry.path}`}
                                className="flex flex-col items-center gap-2 rounded-xl border bg-muted/50 p-3 hover:border-border hover:bg-accent sm:gap-3 sm:p-4"
                              >
                                <Folder className="size-10 fill-muted text-muted-foreground sm:size-12" />
                                <span className="w-full truncate text-center text-xs font-medium sm:text-sm">
                                  {entry.name}
                                </span>
                              </Link>
                            ),
                          )}
                        </div>
                      </section>
                    )}

                    {/* Files section */}
                    {files.length > 0 && (
                      <section>
                        <h2 className="mb-3 text-sm font-medium text-muted-foreground">
                          Files
                        </h2>
                        <div
                          className={cn(
                            view === "list"
                              ? "space-y-1"
                              : "grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6",
                          )}
                        >
                          {files.map((entry) =>
                            view === "list" ? (
                              <div
                                key={entry.path}
                                className="flex cursor-default items-center gap-4 rounded-lg px-4 py-3 hover:bg-accent"
                              >
                                <FileText className="size-6 text-primary" />
                                <span className="flex-1 truncate text-sm">
                                  {entry.name}
                                </span>
                              </div>
                            ) : (
                              <div
                                key={entry.path}
                                className="flex cursor-default flex-col rounded-xl border bg-card hover:border-border hover:shadow-sm"
                              >
                                <div className="flex h-20 items-center justify-center rounded-t-xl bg-muted sm:h-28">
                                  <FileText className="size-8 text-primary sm:size-10" />
                                </div>
                                <div className="border-t p-2 sm:p-3">
                                  <span className="line-clamp-2 text-xs sm:text-sm">
                                    {entry.name}
                                  </span>
                                </div>
                              </div>
                            ),
                          )}
                        </div>
                      </section>
                    )}
                  </>
                ) : (
                  /* Mixed mode - all items together */
                  <div
                    className={cn(
                      view === "list"
                        ? "space-y-1"
                        : "grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6",
                    )}
                  >
                    {sortedEntries.map((entry) =>
                      entry.type === "dir" ? (
                        view === "list" ? (
                          <Link
                            key={entry.path}
                            href={`/files/${entry.path}`}
                            className="flex items-center gap-4 rounded-lg px-4 py-3 hover:bg-accent"
                          >
                            <Folder className="size-6 fill-muted text-muted-foreground" />
                            <span className="flex-1 truncate text-sm font-medium">
                              {entry.name}
                            </span>
                          </Link>
                        ) : (
                          <Link
                            key={entry.path}
                            href={`/files/${entry.path}`}
                            className="flex flex-col items-center gap-2 rounded-xl border bg-muted/50 p-3 hover:border-border hover:bg-accent sm:gap-3 sm:p-4"
                          >
                            <Folder className="size-10 fill-muted text-muted-foreground sm:size-12" />
                            <span className="w-full truncate text-center text-xs font-medium sm:text-sm">
                              {entry.name}
                            </span>
                          </Link>
                        )
                      ) : view === "list" ? (
                        <div
                          key={entry.path}
                          className="flex cursor-default items-center gap-4 rounded-lg px-4 py-3 hover:bg-accent"
                        >
                          <FileText className="size-6 text-primary" />
                          <span className="flex-1 truncate text-sm">
                            {entry.name}
                          </span>
                        </div>
                      ) : (
                        <div
                          key={entry.path}
                          className="flex cursor-default flex-col rounded-xl border bg-card hover:border-border hover:shadow-sm"
                        >
                          <div className="flex h-20 items-center justify-center rounded-t-xl bg-muted sm:h-28">
                            <FileText className="size-8 text-primary sm:size-10" />
                          </div>
                          <div className="border-t p-2 sm:p-3">
                            <span className="line-clamp-2 text-xs sm:text-sm">
                              {entry.name}
                            </span>
                          </div>
                        </div>
                      ),
                    )}
                  </div>
                )
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
