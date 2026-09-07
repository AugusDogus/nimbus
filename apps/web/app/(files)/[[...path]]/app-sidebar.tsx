"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Clock,
  FolderPlus,
  HardDrive,
  Plus,
  Settings,
  Star,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { NimbusLogo } from "@/components/nimbus-logo";
import { NimbusWordmark } from "@/components/nimbus-wordmark";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import type { NewContentState } from "./use-new-content";
import type { StorageSummary } from "./use-file-storage";
import { StorageIndicator } from "./storage-indicator";

const navItems = [
  { icon: HardDrive, label: "My Drive", href: "/" },
  { icon: Users, label: "Shared with me", href: "/shared" },
  { icon: Clock, label: "Recent", href: "/recent" },
  { icon: Star, label: "Starred", href: "/starred" },
];

type AppSidebarProps = {
  storage: StorageSummary;
  canWrite: boolean;
  isAdmin: boolean;
  newContent: NewContentState;
};

export function AppSidebar({
  storage,
  newContent,
  canWrite,
  isAdmin,
}: AppSidebarProps) {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  const closeNavigation = () => setOpenMobile(false);

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader className="h-16 justify-center px-3 group-data-[collapsible=icon]:px-0">
        <Link
          href="/"
          aria-label="Nimbus home"
          onClick={closeNavigation}
          className="flex h-12 items-center gap-3 rounded-xl px-2 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
        >
          <NimbusLogo className="size-8 shrink-0" />
          <NimbusWordmark className="group-data-[collapsible=icon]:hidden" />
        </Link>
      </SidebarHeader>

      <SidebarContent className="gap-4 px-3 pt-4 group-data-[collapsible=icon]:px-0">
        <div className="flex justify-center">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="lg"
                aria-label="New"
                title="New"
                disabled={!canWrite}
                className="h-12 w-full rounded-full bg-create text-create-foreground hover:bg-create/90 group-data-[collapsible=icon]:size-10 group-data-[collapsible=icon]:p-0"
              >
                <span className="relative flex items-center">
                  <Plus
                    className="absolute right-full mr-2 size-5 group-data-[collapsible=icon]:static group-data-[collapsible=icon]:mr-0"
                    strokeWidth={1.8}
                  />
                  <span className="group-data-[collapsible=icon]:hidden">
                    New
                  </span>
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              sideOffset={8}
              className="w-48 rounded-xl p-1.5"
            >
              <DropdownMenuItem
                onSelect={() => {
                  closeNavigation();
                  newContent.openFolderDialog();
                }}
              >
                <FolderPlus />
                New folder
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  closeNavigation();
                  newContent.triggerFileInput();
                }}
              >
                <Upload />
                Upload file
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <nav aria-label="Files">
          <SidebarMenu className="gap-1">
            {navItems.map((item) => {
              const active =
                pathname === item.href ||
                (item.href === "/" && pathname.startsWith("/browse/"));
              return (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    asChild
                    isActive={active}
                    tooltip={item.label}
                    className="h-10 gap-3 rounded-xl px-3 group-data-[collapsible=icon]:mx-auto"
                  >
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      onClick={closeNavigation}
                    >
                      <item.icon strokeWidth={1.7} />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </nav>
      </SidebarContent>

      <SidebarFooter className="gap-3 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-4 group-data-[collapsible=icon]:px-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              tooltip="Trash"
              isActive={pathname === "/trash"}
              className="h-10 gap-3 rounded-xl px-3 group-data-[collapsible=icon]:mx-auto"
            >
              <Link
                href="/trash"
                aria-current={pathname === "/trash" ? "page" : undefined}
                onClick={closeNavigation}
              >
                <Trash2 strokeWidth={1.7} />
                <span>Trash</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {isAdmin && <StorageIndicator storage={storage} />}
        <SidebarMenu className="gap-1">
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              tooltip="Settings"
              isActive={pathname === "/settings"}
              className="size-10 justify-center rounded-xl p-0 group-data-[collapsible=icon]:mx-auto"
            >
              <Link
                href="/settings"
                aria-label="Settings"
                title="Settings"
                aria-current={pathname === "/settings" ? "page" : undefined}
                onClick={closeNavigation}
              >
                <Settings strokeWidth={1.7} />
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
