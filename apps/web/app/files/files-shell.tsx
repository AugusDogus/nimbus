"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { ReactNode } from "react";
import { useCallback } from "react";

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

import { AppSidebar } from "./[[...path]]/app-sidebar";
import { useFileActions } from "./[[...path]]/use-file-actions";
import { useFilePreferences } from "./[[...path]]/use-file-preferences";
import { useFileStorage } from "./[[...path]]/use-file-storage";
import { useUpload } from "./[[...path]]/use-upload";

type FilesShellProps = {
  children: ReactNode;
  initialSession: SessionData | null;
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

export function FilesShell({ children, initialSession }: FilesShellProps) {
  const params = useParams<Params>();
  const pathSegments = normalizePathSegments(params?.path);
  const currentPath = pathSegments.join("/");

  const { data: sessionData } = useSession();
  const session = sessionData ?? initialSession;
  const isAuthed = Boolean(session);

  const { prefs } = useFilePreferences(isAuthed);
  const includeStats =
    prefs.sortField === "modified" || prefs.sortField === "size";

  const storage = useFileStorage(isAuthed);
  const actions = useFileActions({ currentPath, includeStats });
  const upload = useUpload({ currentPath, includeStats });

  const handleUploadFiles = useCallback(
    (files: FileList) => {
      upload.uploadFiles(Array.from(files));
    },
    [upload],
  );

  return (
    <SidebarProvider>
      <AppSidebar
        storage={storage}
        onCreateFolder={actions.createFolder}
        onUploadFiles={handleUploadFiles}
        uploadProgress={upload}
      />
      <SidebarInset>
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

        <main className="flex-1 overflow-x-hidden p-2 md:p-4 lg:p-6">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
