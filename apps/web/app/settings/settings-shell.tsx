// Adapted from T3 Code's settings route layout and breadcrumb, MIT.
// See public/licenses/t3-code/NOTICE.
import { Link } from "@/components/link";
import { UploadProgress } from "@/components/upload-progress";
import { usePathname } from "@/hooks/use-pathname";
import type { ReactNode } from "react";
import { AppFrame } from "@/components/app-frame";
import { PageLayout } from "@/components/page-layout";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { SettingsSidebar, settingsPages } from "./settings-sidebar";

export function SettingsShell({
  isAdmin,
  children,
}: {
  isAdmin: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const page = settingsPages.find((page) => page.href === pathname);

  return (
    <>
      <AppFrame.SidebarBody>
        <SettingsSidebar isAdmin={isAdmin} />
      </AppFrame.SidebarBody>
      <header data-shape="header" className={PageLayout.settingsHeader}>
        <SidebarTrigger
          data-shape="sidebar-trigger"
          className={PageLayout.sidebarTrigger}
        />
        <Breadcrumb
          aria-label="Settings breadcrumb"
          data-shape="settings-trail"
        >
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink render={<Link to="/settings" />}>
                Settings
              </BreadcrumbLink>
            </BreadcrumbItem>
            {page?.section === "Administration" && (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>Administration</BreadcrumbItem>
              </>
            )}
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{page?.label ?? "Settings"}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </header>
      <UploadProgress />
      <div data-slot="page-card" className={PageLayout.settingsContent}>
        <div className={PageLayout.settingsColumn}>{children}</div>
      </div>
    </>
  );
}
