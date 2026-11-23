import { FolderPlus, FolderUp, Plus, Shield, Upload } from "lucide-react";
import { Link, useRouteContext } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { LeaveGuard } from "@/lib/leave-guard";
import { SignOut } from "@/lib/sign-out";
import { toast } from "@/lib/toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { queryClient, trpc } from "@/lib/trpc";
import { UploadProgress } from "@/components/upload-progress";

import { NimbusLogo } from "@/components/nimbus-logo";
import { DrawerActionItem } from "@/components/drawer-action-item";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button, buttonVariants } from "@/components/ui/button";
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
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AppFrame } from "@/components/app-frame";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { capabilitiesQueryOptions } from "./files/capabilities";
import { FolderPath, useFolderPath } from "./files/folder-path";
import { SplitLayout, useSplitLayout } from "./files/split-layout";
import { fileListQueryOptions } from "./files/use-file-list";
import { usePathname } from "@/hooks/use-pathname";
import { trpcErrorCode } from "@/lib/trpc-error";

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

export function FilesShell({ children }: FilesShellProps) {
  // New, Upload and dropped files go to the folder shown, or the active pane's in a split view.
  const split = useSplitLayout();
  const currentPath = SplitLayout.activePath(useFolderPath(), split);
  const { session } = useRouteContext({ from: "/_authed" });

  const isAuthed = Boolean(session);

  const { prefs } = useFilePreferences(isAuthed);
  const includeStats =
    prefs.sortField === "modified" || prefs.sortField === "size";

  // The previous folder's answer stands until the next folder's arrives, as its listing does, so
  // New does not turn off and back on with every move.
  const capabilities = useQuery({
    ...capabilitiesQueryOptions(currentPath),
    enabled: isAuthed,
    placeholderData: keepPreviousData,
  });
  const canWrite = capabilities.data?.canWrite === true;
  // Only a folder page has a place to create in. Trash, Recent, Starred, Shared and search are
  // not one, and New there would quietly create in the drive root; a folder that does not exist,
  // or that the account may not open, has none either. Reads the folder's listing as the page
  // loaded it, without fetching it again.
  const pathname = usePathname();
  const listing = useQuery({
    ...fileListQueryOptions(currentPath, includeStats),
    enabled: false,
  });
  // A pane of a split view sorts on its own, so its listing may be the one with or without stats.
  const paneListing = useQuery({
    ...fileListQueryOptions(currentPath, split ? !includeStats : includeStats),
    enabled: false,
  });
  // A pane whose folder goes away shows that at once, even with its last listing (see `FolderPane`).
  const failed = [listing, paneListing].find(
    (query) => query.isError && (!query.data || split !== null),
  );
  const listingCode = failed ? trpcErrorCode(failed.error) : null;
  const offersNew =
    FolderPath.isShownAt(pathname) &&
    listingCode !== "NOT_FOUND" &&
    listingCode !== "FORBIDDEN";
  // From the account, not the folder: the folder's answer is pending for a moment after every
  // move, and the storage panel would vanish and return.
  const isAdmin =
    useQuery(trpc.access.me.queryOptions()).data?.isAdmin === true;
  const storage = useFileStorage(isAdmin);
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

  // Signing out ends the session at once, so a transfer or upload still running could not
  // report or be undone afterwards: while one runs, the person is asked first, and the session
  // ends only once they confirm.
  const [signOutAsked, setSignOutAsked] = useState(false);
  const signOut = async () => {
    const ended = await SignOut.request();
    if (ended.kind !== "signed-out") {
      toast.error(
        ended.kind === "refused"
          ? `Nimbus could not sign you out (the server answered ${ended.status} without confirming). You are still signed in. Try again.`
          : "Nimbus could not be reached, so you are still signed in. Check your connection, then try again.",
      );
      return;
    }
    queryClient.clear();
    // Asked already, when anything was running.
    LeaveGuard.leave("/login");
  };

  useFileSubscription({
    currentPath,
    includeStats,
    enabled: isAuthed,
  });

  // Single new-content instance shared by sidebar (desktop) and FAB (mobile)
  const [fabDrawerOpen, setFabDrawerOpen] = useState(false);
  const creatable = canWrite && offersNew;
  // The drawer closes, and stays closed, once this page cannot create.
  if (!creatable && fabDrawerOpen) setFabDrawerOpen(false);
  const newContent = useNewContent({
    available: creatable,
    onCreateFolder: actions.createFolder,
    onUploadFiles: uploadFiles,
  });

  return (
    <>
      <AppFrame.SidebarBody>
        <AppSidebar
          storage={storage}
          canWrite={canWrite}
          offersNew={offersNew}
          isAdmin={isAdmin}
          newContent={newContent}
        />
      </AppFrame.SidebarBody>
      <header className="surface-grain sticky top-0 z-20 flex h-16 shrink-0 items-center justify-between gap-2 border-b border-border/40 bg-background px-4 md:gap-4 md:px-6">
        {/* On phones the toggle and logo sit 44 px apart, so their touch areas do not overlap. */}
        <div className="flex min-w-0 flex-1 items-center gap-2 max-md:pointer-coarse:gap-3.5 md:gap-4">
          {/* Desktop: sidebar trigger */}
          <SidebarTrigger className="touch-hit size-8 shrink-0 text-muted-foreground" />

          {/* Mobile: brand logo */}
          <Link
            to="/"
            className="touch-hit shrink-0 md:hidden"
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
                    className="touch-hit relative size-9 rounded-full"
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
                <DropdownMenuGroup>
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
                  {isAdmin && (
                    <DropdownMenuItem render={<Link to="/admin" />}>
                      <Shield />
                      Administration
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => {
                    if (LeaveGuard.busy()) setSignOutAsked(true);
                    else void signOut();
                  }}
                  variant="destructive"
                >
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Link to="/login" className={buttonVariants({ size: "sm" })}>
              Sign in
            </Link>
          )}
        </div>
      </header>

      <UploadProgress />
      <AlertDialog open={signOutAsked} onOpenChange={setSignOutAsked}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-balance">
              Sign out while something is still running?
            </AlertDialogTitle>
            <AlertDialogDescription>
              A move, copy or upload is still running. Signing out now ends it
              without a report or Undo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay signed in</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setSignOutAsked(false);
                void signOut();
              }}
            >
              Sign out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div
        className="flex-1 overflow-x-clip px-4 pb-24 pt-6 md:px-6 md:pb-6 lg:px-8 lg:pt-8"
        onDragOver={(event) => {
          if (
            canWrite &&
            offersNew &&
            event.dataTransfer.types.includes("Files")
          )
            event.preventDefault();
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          // Folder entries must be read during the drop event, before the browser clears them.
          if (canWrite && offersNew)
            void collectDrop(event.dataTransfer).then(uploadFiles);
        }}
      >
        {children}
      </div>

      {/* Mobile FAB for New actions */}
      {canWrite && offersNew && (
        <>
          <Button
            size="lg"
            className="fixed bottom-[calc(max(1.5rem,env(safe-area-inset-bottom))+var(--impersonation-offset,0px))] right-4 z-20 h-14 gap-2.5 rounded-full bg-create text-create-foreground shadow-lg hover:bg-create/90 has-[>svg]:px-6 md:hidden"
            onClick={() => setFabDrawerOpen(true)}
            aria-label="New file or folder"
            data-toast-clearance="narrow"
          >
            <Plus className="size-5" strokeWidth={1.8} />
            New
          </Button>

          <Drawer
            showSwipeHandle
            open={fabDrawerOpen}
            onOpenChange={setFabDrawerOpen}
          >
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
                    <DrawerActionItem onClick={newContent.triggerFolderInput} />
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
    </>
  );
}
