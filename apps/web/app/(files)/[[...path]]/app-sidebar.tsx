"use client";

import Link from "next/link";

import { Clock, Cloud, FolderPlus, HardDrive, Plus, Star, Trash2, Upload, Users } from "lucide-react";

import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

import type { NewContentState } from "./use-new-content";

const navItems = [
  { icon: HardDrive, label: "My Drive", href: "/", isActive: true },
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
  newContent: NewContentState;
  uploadProgress: { isUploading: boolean; progress: number; fileName: string | null };
};

export function AppSidebar({ storage, newContent, uploadProgress }: AppSidebarProps) {
  return (
    <>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="Nimbus">
                <Link href="/">
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
                      <DropdownMenuItem onClick={newContent.openFolderDialog}>
                        <FolderPlus />
                        New folder
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={newContent.triggerFileInput}>
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

    </>
  );
}
