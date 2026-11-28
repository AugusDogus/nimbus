import { FolderPlus, FolderUp, Plus, Shield, Upload } from "lucide-react";
import { Link, useNavigate, useRouteContext } from "@tanstack/react-router";
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
} from "@/components/alert-dialog";
import { queryClient, trpc } from "@/lib/trpc";
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
  DropdownContent,
  DropdownLabel,
  DropdownMenu,
  DropdownSeparator,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import { MenuItem } from "@/components/ui/menu-item";
import { menuRowLink } from "@/components/menu-row-link";
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
import { PageLayout } from "@/components/page-layout";
import { useHeaderEdges } from "@/components/use-header-edges";
import { cn } from "@/lib/utils";
import { HeaderToolsSlot } from "./files/header-tools";
import { HiddenFileInput, NewFolderDialog } from "./files/new-content-ui";
import { useFileActions } from "./files/use-file-actions";
import { useFilePreferences } from "./files/use-file-preferences";
import { useFileStorage } from "./files/use-file-storage";
import { useFileSubscription } from "./files/use-file-subscription";
import { useNewContent } from "./files/use-new-content";
import { Arrivals } from "./files/arrivals";
import { NewButton } from "./files/new-button";
import { NewTarget } from "./files/new-target";
import { fileHref } from "./files/types";
import { useUploads } from "@/components/upload-provider";
import { collectDrop, type CollectedUpload } from "@/lib/upload-sources";

type FilesShellProps = {
  children: ReactNode;
};

export function FilesShell({ children }: FilesShellProps) {
  // New, Upload and dropped files go to the folder shown, or the active pane's in a split view.
  const split = useSplitLayout();
  const currentPath = SplitLayout.activePath(useFolderPath(), split);
  // The session alone: the route's context is rebuilt on every navigation, which would render
  // this again each time, even for a change of the active pane.
  const session = useRouteContext({
    from: "/_authed",
    select: (context) => context.session,
  });

  const isAuthed = Boolean(session);

  const { prefs } = useFilePreferences(isAuthed);
  const includeStats =
    prefs.sortField === "modified" || prefs.sortField === "size";

  // Only a folder page has a folder to create in. Trash, Recent, Starred, Shared and search are
  // not one; a folder that does not exist, or that the account may not open, is not either. New
  // there creates in the Files home instead (see `NewTarget`). Reads the folder's listing as the
  // page loaded it, without fetching it again.
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
  const onFolder =
    FolderPath.isShownAt(pathname) &&
    listingCode !== "NOT_FOUND" &&
    listingCode !== "FORBIDDEN";
  const me = useQuery(trpc.access.me.queryOptions()).data;
  // From the account, not the folder: the folder's answer is pending for a moment after every
  // move, and the storage panel would vanish and return.
  const isAdmin = me?.isAdmin === true;
  const storage = useFileStorage(isAdmin);
  // The previous folder's answer stands until the next folder's arrives, as its listing does, so
  // New does not turn off and back on with every move.
  const capabilities = useQuery({
    ...capabilitiesQueryOptions(currentPath),
    enabled: isAuthed && onFolder,
    placeholderData: keepPreviousData,
  });
  const canWrite = capabilities.data?.canWrite === true;
  // Off a folder: the folder Files opens, and the home folder should that be one it cannot add to.
  const top = me?.top ?? "";
  const topCapabilities = useQuery({
    ...capabilitiesQueryOptions(top),
    enabled: isAuthed && me !== undefined && !onFolder,
  });
  const home = me?.home ?? null;
  const homeCapabilities = useQuery({
    ...capabilitiesQueryOptions(home ?? ""),
    enabled:
      isAuthed &&
      !onFolder &&
      home !== null &&
      home !== top &&
      topCapabilities.data?.canWrite === false,
  });
  const newTarget = NewTarget.resolve(
    onFolder
      ? {
          page: "folder",
          path: currentPath,
          canWrite: capabilities.data?.canWrite,
        }
      : {
          page: "other",
          top: { path: top, canWrite: topCapabilities.data?.canWrite },
          home:
            home === null || home === top
              ? null
              : { path: home, canWrite: homeCapabilities.data?.canWrite },
        },
  );
  const newPath = NewTarget.path(newTarget);
  const actions = useFileActions({ currentPath, includeStats });
  const upload = useUploads();
  const navigate = useNavigate();
  // Off a folder, New's work lands in the Files home: the page goes there, and what arrives is
  // highlighted as it shows.
  const goHome = useCallback(() => {
    if (newTarget.kind === "home")
      void navigate({ href: fileHref(newTarget.path) });
  }, [navigate, newTarget]);
  const uploadTo = useCallback(
    (collected: CollectedUpload, path: string, arrive: boolean) => {
      if (session)
        void upload.uploadFiles(
          collected,
          { path, userId: session.user.id },
          arrive ? Arrivals.record : undefined,
        );
    },
    [upload, session],
  );
  // Dropped files go to the folder shown, only ever on a folder page.
  const uploadFiles = useCallback(
    (collected: CollectedUpload) => uploadTo(collected, currentPath, false),
    [uploadTo, currentPath],
  );
  const uploadNew = useCallback(
    (collected: CollectedUpload) => {
      if (newPath === null) return;
      goHome();
      uploadTo(collected, newPath, newTarget.kind === "home");
    },
    [uploadTo, newPath, newTarget, goHome],
  );
  const createNewFolder = useCallback(
    async (name: string) => {
      if (newPath === null) return;
      await actions.createFolder(name, newPath);
      if (newTarget.kind !== "home") return;
      Arrivals.record([[newPath, name].filter(Boolean).join("/")]);
      goHome();
    },
    [actions, newPath, newTarget, goHome],
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

  const [toolsSlot, setToolsSlot] = useState<HTMLElement | null>(null);
  const [attachHeader, attachHeaderStart, attachHeaderEnd] = useHeaderEdges();

  // Single new-content instance shared by sidebar (desktop) and FAB (mobile)
  // The folder the open drawer creates in; it closes, and stays closed, once the page creates
  // elsewhere or nowhere.
  const [fabDrawerFor, setFabDrawerFor] = useState<string | null>(null);
  if (fabDrawerFor !== null && fabDrawerFor !== newPath) setFabDrawerFor(null);
  const newContent = useNewContent({
    target: newPath,
    onCreateFolder: createNewFolder,
    onUploadFiles: uploadNew,
  });
  // Where nothing can be created, New stays, dimmed, and a press says why: the sidebar's tooltip
  // shows it on a pointer's hover or focus, which a finger has neither of.
  const explainNew = () => {
    if (newTarget.kind === "none") toast(newTarget.reason);
  };
  const fabState = NewButton.state(newTarget);

  return (
    <>
      <AppFrame.SidebarBody>
        <AppSidebar
          storage={storage}
          newTarget={newTarget}
          onExplainNew={explainNew}
          isAdmin={isAdmin}
          newContent={newContent}
        />
      </AppFrame.SidebarBody>
      <header
        ref={attachHeader}
        data-shape="header"
        className={PageLayout.filesHeader}
      >
        <div ref={attachHeaderStart} className={PageLayout.filesHeaderStart}>
          {/* Desktop: sidebar trigger */}
          <SidebarTrigger
            data-shape="sidebar-trigger"
            className={PageLayout.sidebarTrigger}
          />

          {/* Mobile: brand logo */}
          <Link
            to="/"
            // reach: from 768 px the sidebar's brand links home
            className="touch-hit shrink-0 md:hidden"
            aria-label="Nimbus home"
          >
            <NimbusLogo className={PageLayout.logo} />
          </Link>
        </div>

        <SearchBox />

        <div ref={attachHeaderEnd} className={PageLayout.filesHeaderEnd}>
          <span ref={setToolsSlot} className="contents" />
          {session ? (
            <DropdownMenu>
              <DropdownTrigger
                render={
                  <Button
                    variant="ghost"
                    aria-label="Account menu"
                    data-shape="account"
                    className={PageLayout.account}
                  />
                }
              >
                <Avatar>
                  <AvatarFallback className={PageLayout.avatarFallback}>
                    {PageLayout.initial(session.user)}
                  </AvatarFallback>
                </Avatar>
              </DropdownTrigger>
              <DropdownContent align="end" className="w-56">
                <DropdownLabel>
                  <div className="flex flex-col space-y-1">
                    {session.user.name && (
                      <p className="text-sm font-medium text-foreground">
                        {session.user.name}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {session.user.email}
                    </p>
                  </div>
                </DropdownLabel>
                {isAdmin && (
                  <MenuItem
                    index={0}
                    icon={Shield}
                    label="Administration"
                    {...menuRowLink(<Link to="/admin" />)}
                  />
                )}
                <DropdownSeparator />
                <MenuItem
                  index={isAdmin ? 1 : 0}
                  label="Sign out"
                  destructive
                  onSelect={() => {
                    if (LeaveGuard.busy()) setSignOutAsked(true);
                    else void signOut();
                  }}
                />
              </DropdownContent>
            </DropdownMenu>
          ) : (
            <Button size="compact" render={<Link to="/login" />}>
              Sign in
            </Button>
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
        className={PageLayout.filesContent}
        onDragOver={(event) => {
          if (
            onFolder &&
            canWrite &&
            event.dataTransfer.types.includes("Files")
          )
            event.preventDefault();
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          // Folder entries must be read during the drop event, before the browser clears them.
          if (onFolder && canWrite)
            void collectDrop(event.dataTransfer).then(uploadFiles);
        }}
      >
        <HeaderToolsSlot.Provider value={toolsSlot}>
          {children}
        </HeaderToolsSlot.Provider>
      </div>

      {/* Mobile FAB for New actions, on every files page as the sidebar's New is. Their cards
          keep room below their last rows for it (see `PageLayout.filesContent`). */}
      <Button
        leadingIcon={Plus}
        {...fabState}
        className={cn(NewButton.looks.floating, fabState.className)}
        onClick={() =>
          newPath === null ? explainNew() : setFabDrawerFor(newPath)
        }
        aria-label="New file or folder"
        data-shape="new-floating"
        data-toast-clearance="narrow"
      >
        New
      </Button>
      <Drawer
        showSwipeHandle
        open={fabDrawerFor !== null}
        onOpenChange={(open) => setFabDrawerFor(open ? newPath : null)}
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

      <HiddenFileInput
        fileInputRef={newContent.fileInputRef}
        handleFileChange={newContent.handleFileChange}
      />
      <NewFolderDialog state={newContent} />
    </>
  );
}
