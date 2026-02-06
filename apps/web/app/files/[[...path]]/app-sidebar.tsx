"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";

import { Clock, Cloud, FolderPlus, HardDrive, Plus, Star, Trash2, Upload, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

const navItems = [
  { icon: HardDrive, label: "My Drive", href: "/files", isActive: true },
  { icon: Users, label: "Shared with me", href: "", disabled: true },
  { icon: Clock, label: "Recent", href: "", disabled: true },
  { icon: Star, label: "Starred", href: "", disabled: true },
  { icon: Trash2, label: "Trash", href: "", disabled: true },
];

export type StorageSummary = {
  usedBytes: number | null;
  label: string;
  progressValue: number;
  isLoading: boolean;
};

type AppSidebarProps = {
  storage: StorageSummary;
  onCreateFolder: (name: string) => Promise<void>;
  onUploadFiles: (files: FileList) => void;
  uploadProgress: { isUploading: boolean; progress: number; fileName: string | null };
};

export function AppSidebar({ storage, onCreateFolder, onUploadFiles, uploadProgress }: AppSidebarProps) {
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [creating, setCreating] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleCreateFolder = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!folderName.trim()) return;
      setCreating(true);
      try {
        await onCreateFolder(folderName.trim());
        setFolderDialogOpen(false);
        setFolderName("");
      } catch {
        // error toast from hook
      } finally {
        setCreating(false);
      }
    },
    [folderName, onCreateFolder],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        onUploadFiles(e.target.files);
        // Reset so the same file can be selected again
        e.target.value = "";
      }
    },
    [onUploadFiles],
  );

  return (
    <>
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
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <SidebarMenuButton
                        tooltip="New"
                        className="bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
                      >
                        <Plus />
                        <span>New</span>
                      </SidebarMenuButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="right" align="start" className="w-48">
                      <DropdownMenuItem
                        onClick={() => {
                          setFolderName("");
                          setFolderDialogOpen(true);
                        }}
                      >
                        <FolderPlus />
                        New folder
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => fileInputRef.current?.click()}>
                        <Upload />
                        Upload file
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
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
            {uploadProgress.isUploading && (
              <div className="space-y-1">
                <p className="truncate text-xs text-muted-foreground">
                  Uploading {uploadProgress.fileName}
                </p>
                <Progress value={uploadProgress.progress} className="h-1.5" />
                <p className="text-xs tabular-nums text-muted-foreground">
                  {uploadProgress.progress}%
                </p>
              </div>
            )}
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

      {/* Hidden file input for uploads */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileChange}
      />

      {/* New folder dialog */}
      <Dialog open={folderDialogOpen} onOpenChange={setFolderDialogOpen}>
        <DialogContent>
          <form onSubmit={handleCreateFolder}>
            <DialogHeader>
              <DialogTitle>New folder</DialogTitle>
              <DialogDescription>Enter a name for the new folder</DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <Input
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                placeholder="Untitled folder"
                autoFocus
                autoComplete="off"
                data-1p-ignore
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setFolderDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={creating || !folderName.trim()}>
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
