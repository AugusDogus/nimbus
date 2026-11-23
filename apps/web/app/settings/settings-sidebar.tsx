// Adapted from T3 Code's SettingsSidebarNav, MIT.
// See public/licenses/t3-code/NOTICE.
import { Link } from "@/components/link";
import { usePathname } from "@/hooks/use-pathname";
import type { ReactElement } from "react";
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

type SettingsHref = (typeof settingsPages)[number]["href"];

/**
 * Settings' navigation in the sidebar. `link` renders each place's link, or, in the skeleton the
 * server sends before the app runs, what stands in for it, so both have the same parts.
 */
function SettingsNav({
  isAdmin,
  current,
  link,
}: {
  isAdmin: boolean;
  current: string | null;
  link: (href: SettingsHref | "/", current: boolean) => ReactElement;
}) {
  return (
    <>
      <SidebarContent className="gap-4 px-1 pt-2">
        <nav aria-label="Settings">
          {(["Settings", "Administration"] as const).map((section) => {
            if (section === "Administration" && !isAdmin) return null;
            return (
              <SidebarGroup key={section}>
                <SidebarGroupLabel>{section}</SidebarGroupLabel>
                <SidebarMenu>
                  {settingsPages
                    .filter((page) => page.section === section)
                    .map((page) => (
                      <SidebarMenuItem key={page.href}>
                        <SidebarMenuButton
                          icon={page.icon}
                          isActive={current === page.href}
                          data-shape={`settings-nav-${page.href}`}
                          render={link(page.href, current === page.href)}
                        >
                          {page.label}
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                </SidebarMenu>
              </SidebarGroup>
            );
          })}
        </nav>
      </SidebarContent>
      <SidebarFooter className="px-1 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              icon={ArrowLeft}
              data-shape="settings-nav-back"
              render={link("/", false)}
            >
              Back to files
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}

export function SettingsSidebar({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  return (
    <SettingsNav
      isAdmin={isAdmin}
      current={pathname}
      link={(href, current) => (
        <Link
          to={href}
          aria-current={current ? "page" : undefined}
          onClick={() => setOpenMobile(false)}
        />
      )}
    />
  );
}

/** Settings' navigation as a page's skeleton shows it: the same parts, not yet links. */
export function SettingsSidebarPlaceholder({
  isAdmin,
  current,
}: {
  isAdmin: boolean;
  current: string | null;
}) {
  return (
    <SettingsNav isAdmin={isAdmin} current={current} link={() => <div />} />
  );
}
