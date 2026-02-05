import Link from "next/link";

import { Clock, Cloud, HardDrive, Plus, Star, Trash2, Users } from "lucide-react";

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

export function AppSidebar({ storage }: { storage: StorageSummary }) {
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
