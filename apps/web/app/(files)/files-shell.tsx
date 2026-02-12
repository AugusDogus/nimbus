"use client";

import { Cloud, FolderPlus, Plus, Search, Upload } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";

import { ThemeToggle } from "@/components/theme-toggle";
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
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { signOut, useSession } from "@/lib/auth-client";

import type { UserPreferences } from "@nimbus/api/context";

import { AppSidebar } from "./[[...path]]/app-sidebar";
import { HiddenFileInput, NewFolderDialog } from "./[[...path]]/new-content-ui";
import { useFileActions } from "./[[...path]]/use-file-actions";
import { useFilePreferences } from "./[[...path]]/use-file-preferences";
import { useFileStorage } from "./[[...path]]/use-file-storage";
import { useFileSubscription } from "./[[...path]]/use-file-subscription";
import { useNewContent } from "./[[...path]]/use-new-content";
import { useUpload } from "./[[...path]]/use-upload";

type FilesShellProps = {
  children: ReactNode;
  initialSession: SessionData | null;
  initialPrefs: UserPreferences | null;
};

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

export function FilesShell({
  children,
  initialSession,
  initialPrefs,
}: FilesShellProps) {
  const params = useParams<Params>();
  const pathSegments = normalizePathSegments(params?.path);
  const currentPath = pathSegments.join("/");

  const { data: sessionData } = useSession();
  const session = sessionData ?? initialSession;
  const isAuthed = Boolean(session);

  const { prefs } = useFilePreferences(isAuthed, initialPrefs ?? undefined);
  const includeStats =
    prefs.sortField === "modified" || prefs.sortField === "size";

  const storage = useFileStorage(isAuthed);
  const actions = useFileActions({ currentPath, includeStats });
  const upload = useUpload({ currentPath, includeStats });

  useFileSubscription({
    currentPath,
    includeStats,
    enabled: isAuthed,
  });

  const handleUploadFiles = useCallback(
    (files: FileList) => {
      upload.uploadFiles(Array.from(files));
    },
    [upload],
  );

  // Single new-content instance shared by sidebar (desktop) and FAB (mobile)
  const [fabDrawerOpen, setFabDrawerOpen] = useState(false);
  const newContent = useNewContent({
    onCreateFolder: actions.createFolder,
    onUploadFiles: handleUploadFiles,
  });

  return (
    <SidebarProvider>
      <AppSidebar
        storage={storage}
        newContent={newContent}
        uploadProgress={upload}
      />
      <SidebarInset>
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-2 border-b bg-background/80 px-3 backdrop-blur-sm md:h-16 md:gap-4 md:px-4">
          <div className="flex flex-1 items-center gap-2 md:gap-4">
            {/* Desktop: sidebar trigger */}
            <SidebarTrigger className="hidden md:inline-flex" />

            {/* Mobile: brand logo */}
            <Link href="/" className="shrink-0 md:hidden" aria-label="Nimbus home">
              <Cloud className="size-5 text-primary" />
            </Link>

            {/* Search bar -- always visible */}
            <div className="relative max-w-md flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search in Drive"
                className="h-9 rounded-full bg-muted pl-10 md:h-10"
              />
            </div>
          </div>

          <div className="flex items-center gap-1 md:gap-3">
            <ThemeToggle />
            {session ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="relative size-9 rounded-full">
                    <Avatar>
                      <AvatarFallback className="bg-primary text-primary-foreground">
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
                        <p className="text-sm font-medium">{session.user.name}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {session.user.email}
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

        <main className="flex-1 overflow-x-hidden p-2 pb-20 md:p-4 md:pb-4 lg:p-6">
          {children}
        </main>

        {/* Mobile FAB for New actions */}
        {isAuthed && (
          <>
            <Button
              size="icon-lg"
              className="fixed bottom-6 right-4 z-20 size-14 rounded-full shadow-lg md:hidden"
              onClick={() => setFabDrawerOpen(true)}
              aria-label="New file or folder"
            >
              <Plus className="size-6" />
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

        <HiddenFileInput state={newContent} />
        <NewFolderDialog state={newContent} />
      </SidebarInset>
    </SidebarProvider>
  );
}