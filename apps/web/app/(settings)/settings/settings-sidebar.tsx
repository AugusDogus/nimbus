"use client";

// Adapted from T3 Code's SettingsSidebarNav, MIT.
// See public/licenses/t3-code/NOTICE.
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeft,
  Cable,
  Palette,
  ScrollText,
  UserRound,
  Users,
} from "lucide-react";
import { NimbusLogo } from "@/components/nimbus-logo";
import { NimbusWordmark } from "@/components/nimbus-wordmark";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

export const settingsPages = [
  {
    href: "/settings/appearance",
    label: "Appearance",
    icon: Palette,
    section: "Settings",
  },
  {
    href: "/settings/account",
    label: "Account",
    icon: UserRound,
    section: "Settings",
  },
  {
    href: "/settings/webdav",
    label: "WebDAV",
    icon: Cable,
    section: "Settings",
  },
  {
    href: "/settings/admin",
    label: "Users & groups",
    icon: Users,
    section: "Administration",
  },
  {
    href: "/settings/admin/audit",
    label: "Audit log",
    icon: ScrollText,
    section: "Administration",
  },
] as const;

export function SettingsSidebar({ isAdmin }: { isAdmin: boolean }) {
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
          <NimbusLogo className="size-8" />
          <NimbusWordmark className="group-data-[collapsible=icon]:hidden" />
        </Link>
      </SidebarHeader>
      <SidebarContent className="gap-4 pt-4">
        <nav aria-label="Settings">
          {(["Settings", "Administration"] as const).map((section) => {
            if (section === "Administration" && !isAdmin) return null;
            return (
              <SidebarGroup
                key={section}
                className="px-3 group-data-[collapsible=icon]:px-0"
              >
                <SidebarGroupLabel>{section}</SidebarGroupLabel>
                <SidebarMenu className="gap-1">
                  {settingsPages
                    .filter((page) => page.section === section)
                    .map((page) => (
                      <SidebarMenuItem key={page.href}>
                        <SidebarMenuButton
                          asChild
                          isActive={pathname === page.href}
                          tooltip={page.label}
                          className="h-10 gap-3 rounded-xl px-3 group-data-[collapsible=icon]:mx-auto"
                        >
                          <Link
                            href={page.href}
                            aria-current={
                              pathname === page.href ? "page" : undefined
                            }
                            onClick={closeNavigation}
                          >
                            <page.icon strokeWidth={1.7} />
                            <span>{page.label}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                </SidebarMenu>
              </SidebarGroup>
            );
          })}
        </nav>
      </SidebarContent>
      <SidebarFooter className="px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] group-data-[collapsible=icon]:px-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              tooltip="Back to files"
              className="h-10 gap-3 rounded-xl px-3 group-data-[collapsible=icon]:mx-auto"
            >
              <Link href="/" onClick={closeNavigation}>
                <ArrowLeft strokeWidth={1.7} />
                <span>Back to files</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
