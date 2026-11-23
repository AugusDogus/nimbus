// Adapted from T3 Code's SettingsSidebarNav, MIT.
// See public/licenses/t3-code/NOTICE.
import { Link } from "@/components/link";
import { usePathname } from "@/hooks/use-pathname";
import {
  ArrowLeft,
  Bot,
  Cable,
  Library,
  Palette,
  ScrollText,
  UserRound,
  Users,
} from "lucide-react";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
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
    href: "/settings/mcp",
    label: "MCP",
    icon: Bot,
    section: "Settings",
  },
  {
    href: "/settings/libraries",
    label: "Libraries",
    icon: Library,
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
    <>
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
                          isActive={pathname === page.href}
                          tooltip={page.label}
                          className="h-10 gap-3 rounded-xl px-3 group-data-[collapsible=icon]:mx-auto"
                          render={
                            <Link
                              to={page.href}
                              aria-current={
                                pathname === page.href ? "page" : undefined
                              }
                              onClick={closeNavigation}
                            />
                          }
                        >
                          <page.icon strokeWidth={1.7} />
                          <span>{page.label}</span>
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
              tooltip="Back to files"
              className="h-10 gap-3 rounded-xl px-3 group-data-[collapsible=icon]:mx-auto"
              render={<Link to="/" onClick={closeNavigation} />}
            >
              <ArrowLeft strokeWidth={1.7} />
              <span>Back to files</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
