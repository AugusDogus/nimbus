"use client";

import { FolderPlus, Plus, Search, Shield, Upload } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { queryClient, trpcClient } from "@/lib/trpc";
import { UploadProgress } from "@/components/upload-progress";

import { NimbusLogo } from "@/components/nimbus-logo";
import { DrawerActionItem } from "@/components/drawer-action-item";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { signOut, useSession } from "@/lib/auth-client";
import { decodeFilePathSegments } from "@/lib/file-route";

import type { UserPreferences } from "@nimbus/api/context";

import { AppSidebar } from "./[[...path]]/app-sidebar";
import { HiddenFileInput, NewFolderDialog } from "./[[...path]]/new-content-ui";
import { useFileActions } from "./[[...path]]/use-file-actions";
import { useFilePreferences } from "./[[...path]]/use-file-preferences";
import { useFileStorage } from "./[[...path]]/use-file-storage";
import { useFileSubscription } from "./[[...path]]/use-file-subscription";
import { useNewContent } from "./[[...path]]/use-new-content";
import { useUploads } from "@/components/upload-provider";

type FilesShellProps = {
  children: ReactNode;
  initialSession: SessionData | null;
  initialPrefs: UserPreferences | null;
};

type SessionData = ReturnType<typeof useSession>["data"];

type Params = {
  path?: string[] | string;
};

const sidebarStyle: CSSProperties & Record<`--${string}`, string> = {
  "--sidebar-width": "16rem",
  "--sidebar-width-icon": "4rem",
};

export function FilesShell({
  children,
  initialSession,
  initialPrefs,
}: FilesShellProps) {
  const router = useRouter();
  const params = useParams<Params>();
  const pathSegments = decodeFilePathSegments(params?.path);
  const currentPath = pathSegments.join("/");

  const { data: sessionData, isPending } = useSession();
  const session = isPending ? initialSession : sessionData;
  const isAuthed = Boolean(session);

  const { prefs } = useFilePreferences(isAuthed, initialPrefs ?? undefined);
  const includeStats =
    prefs.sortField === "modified" || prefs.sortField === "size";

  const capabilities = useQuery({
    queryKey: ["capabilities", currentPath],
    queryFn: () => trpcClient.access.capabilities.query({ path: currentPath }),
    enabled: isAuthed,
  });
  const canWrite = capabilities.data?.canWrite === true;
  const storage = useFileStorage(capabilities.data?.isAdmin === true);
  const actions = useFileActions({ currentPath, includeStats });
  const upload = useUploads();
  const uploadFiles = useCallback(
    (files: File[]) => {
      if (session)
        upload.uploadFiles(files, {
          path: currentPath,
          userId: session.user.id,
        });
    },
    [upload, currentPath, session],
  );

  useFileSubscription({
    currentPath,
    includeStats,
    enabled: isAuthed,
  });

  const handleUploadFiles = useCallback(
    (files: FileList) => {
      uploadFiles(Array.from(files));
    },
    [uploadFiles],
  );

  // Single new-content instance shared by sidebar (desktop) and FAB (mobile)
  const [fabDrawerOpen, setFabDrawerOpen] = useState(false);
  const newContent = useNewContent({
    onCreateFolder: actions.createFolder,
    onUploadFiles: handleUploadFiles,
  });

  return (
    <SidebarProvider
      style={sidebarStyle}
      className="surface-grain h-dvh min-h-0 overflow-hidden"
    >
      <AppSidebar
        storage={storage}
        canWrite={canWrite}
        isAdmin={capabilities.data?.isAdmin === true}
        newContent={newContent}
      />
      <SidebarInset className="surface-grain min-h-0 min-w-0 overflow-x-hidden overflow-y-auto">
        <header className="surface-grain sticky top-0 z-10 flex h-16 shrink-0 items-center justify-between gap-2 border-b border-border/40 bg-background px-4 md:gap-4 md:px-6">
          <div className="flex min-w-0 flex-1 items-center gap-2 md:gap-4">
            {/* Desktop: sidebar trigger */}
            <SidebarTrigger className="size-8 shrink-0 text-muted-foreground" />

            {/* Mobile: brand logo */}
            <Link
              href="/"
              className="shrink-0 md:hidden"
              aria-label="Nimbus home"
            >
              <NimbusLogo className="size-7" />
            </Link>

            {/* Search bar -- always visible */}
            <form
              role="search"
              className="relative min-w-0 max-w-lg flex-1"
              onSubmit={(event) => {
                event.preventDefault();
                const query = new FormData(event.currentTarget).get("q");
                if (typeof query === "string" && query.trim())
                  router.push(`/search?q=${encodeURIComponent(query.trim())}`);
              }}
            >
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                name="q"
                aria-label="Search files"
                placeholder="Search files"
                className="h-9 rounded-lg border-transparent bg-muted/70 pl-10 shadow-none focus-visible:border-ring md:h-10 dark:bg-sidebar/70"
              />
            </form>
          </div>

          <div className="flex shrink-0 items-center gap-1 md:gap-3">
            {session ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    aria-label="Account menu"
                    className="relative size-9 rounded-full"
                  >
                    <Avatar>
                      <AvatarFallback className="bg-secondary text-secondary-foreground">
                        {session.user.name?.charAt(0).toUpperCase() ||
                          session.user.email?.charAt(0).toUpperCase() ||
                          "U"}
                      </AvatarFallback>
                    </Avatar>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>
                    <div className="flex flex-col space-y-1">
                      {session.user.name && (
                        <p className="text-sm font-medium">
                          {session.user.name}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {session.user.email}
                      </p>
                    </div>
                  </DropdownMenuLabel>
                  {capabilities.data?.isAdmin === true && (
                    <DropdownMenuItem asChild>
                      <Link href="/admin">
                        <Shield />
                        Administration
                      </Link>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={async () => {
                      const result = await signOut();
                      if (result.error) {
                        toast.error(
                          result.error.message ??
                            "Could not sign out. Try again.",
                        );
                        return;
                      }
                      queryClient.clear();
                      window.location.assign("/login");
                    }}
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

        <UploadProgress />
        <div
          className="flex-1 overflow-x-clip px-4 pb-24 pt-6 md:px-6 md:pb-6 lg:px-8 lg:pt-8"
          onDragOver={(event) => {
            if (canWrite && event.dataTransfer.types.includes("Files"))
              event.preventDefault();
          }}
          onDrop={(event) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            if (canWrite) uploadFiles(Array.from(event.dataTransfer.files));
          }}
        >
          {children}
        </div>

        {/* Mobile FAB for New actions */}
        {canWrite && (
          <>
            <Button
              size="lg"
              className="fixed bottom-[max(1.5rem,env(safe-area-inset-bottom))] right-4 z-20 h-14 gap-2.5 rounded-full bg-create text-create-foreground shadow-lg hover:bg-create/90 has-[>svg]:px-6 md:hidden"
              onClick={() => setFabDrawerOpen(true)}
              aria-label="New file or folder"
            >
              <Plus className="size-5" strokeWidth={1.8} />
              New
            </Button>

            <Drawer open={fabDrawerOpen} onOpenChange={setFabDrawerOpen}>
              <DrawerContent>
                <DrawerHeader>
                  <DrawerTitle>Create new</DrawerTitle>
                  <DrawerDescription className="sr-only">
                    Create a new file or folder
                  </DrawerDescription>
                </DrawerHeader>
                <div className="flex flex-col gap-1 px-4 pb-6">
                  <DrawerClose asChild>
                    <DrawerActionItem onClick={newContent.openFolderDialog}>
                      <FolderPlus className="size-5 text-muted-foreground" />
                      New folder
                    </DrawerActionItem>
                  </DrawerClose>
                  <DrawerClose asChild>
                    <DrawerActionItem onClick={newContent.triggerFileInput}>
                      <Upload className="size-5 text-muted-foreground" />
                      Upload file
                    </DrawerActionItem>
                  </DrawerClose>
                </div>
              </DrawerContent>
            </Drawer>
          </>
        )}

        <HiddenFileInput
          fileInputRef={newContent.fileInputRef}
          handleFileChange={newContent.handleFileChange}
        />
        <NewFolderDialog state={newContent} />
      </SidebarInset>
    </SidebarProvider>
  );
}
