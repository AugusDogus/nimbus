import { FolderPlus, FolderUp, Plus, Shield, Upload } from "lucide-react";
import { Link, useRouteContext } from "@tanstack/react-router";
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
  DropdownMenuLinkItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { useFolderPath } from "./files/folder-path";

import { AppSidebar } from "./files/app-sidebar";
import { SearchBox } from "./search/search-box";
import { HiddenFileInput, NewFolderDialog } from "./files/new-content-ui";
import { useFileActions } from "./files/use-file-actions";
import { useFilePreferences } from "./files/use-file-preferences";
import { useFileStorage } from "./files/use-file-storage";
import { useFileSubscription } from "./files/use-file-subscription";
import { useNewContent } from "./files/use-new-content";
import { useUploads } from "@/components/upload-provider";
import { collectDrop, type CollectedUpload } from "@/lib/upload-sources";

type FilesShellProps = {
  children: ReactNode;
};

const sidebarStyle: CSSProperties & Record<`--${string}`, string> = {
  "--sidebar-width": "16rem",
  "--sidebar-width-icon": "4rem",
};

export function FilesShell({ children }: FilesShellProps) {
  const currentPath = useFolderPath();
  const { session } = useRouteContext({ from: "/_authed" });

  const isAuthed = Boolean(session);

  const { prefs } = useFilePreferences(isAuthed);
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
    (collected: CollectedUpload) => {
      if (session)
        void upload.uploadFiles(collected, {
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

  // Single new-content instance shared by sidebar (desktop) and FAB (mobile)
  const [fabDrawerOpen, setFabDrawerOpen] = useState(false);
  const newContent = useNewContent({
    onCreateFolder: actions.createFolder,
    onUploadFiles: uploadFiles,
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
              to="/"
              className="shrink-0 md:hidden"
              aria-label="Nimbus home"
            >
              <NimbusLogo className="size-7" />
            </Link>

            {/* Search bar -- always visible */}
            <SearchBox />
          </div>

          <div className="flex shrink-0 items-center gap-1 md:gap-3">
            {session ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      aria-label="Account menu"
                      className="relative size-9 rounded-full"
                    />
                  }
                >
                  <Avatar>
                    <AvatarFallback className="bg-secondary text-secondary-foreground">
                      {session.user.name?.charAt(0).toUpperCase() ||
                        session.user.email?.charAt(0).toUpperCase() ||
                        "U"}
                    </AvatarFallback>
                  </Avatar>
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
                    <DropdownMenuLinkItem render={<Link to="/admin" />}>
                      <Shield />
                      Administration
                    </DropdownMenuLinkItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() =>
                      void (async () => {
                        // The auth client loads only for this, not with every page.
                        const { signOut } = await import("@/lib/auth-client");
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
                      })()
                    }
                    variant="destructive"
                  >
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button
                nativeButton={false}
                size="sm"
                render={<Link to="/login" />}
              >
                Sign in
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
            // Folder entries must be read during the drop event, before the browser clears them.
            if (canWrite)
              void collectDrop(event.dataTransfer).then(uploadFiles);
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
                  <DrawerClose
                    render={
                      <DrawerActionItem onClick={newContent.openFolderDialog} />
                    }
                  >
                    <FolderPlus className="size-5 text-muted-foreground" />
                    New folder
                  </DrawerClose>
                  <DrawerClose
                    render={
                      <DrawerActionItem onClick={newContent.triggerFileInput} />
                    }
                  >
                    <Upload className="size-5 text-muted-foreground" />
                    Upload file
                  </DrawerClose>
                  <DrawerClose
                    render={
                      <DrawerActionItem
                        onClick={newContent.triggerFolderInput}
                      />
                    }
                  >
                    <FolderUp className="size-5 text-muted-foreground" />
                    Upload folder
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
