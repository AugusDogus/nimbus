"use client";

// Adapted from T3 Code's settings route layout and breadcrumb, MIT.
// See public/licenses/t3-code/NOTICE.
import Link from "next/link";
import { UploadProgress } from "@/components/upload-progress";
import { usePathname } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { SettingsSidebar, settingsPages } from "./settings-sidebar";

const sidebarStyle: CSSProperties & Record<`--${string}`, string> = {
  "--sidebar-width": "16rem",
  "--sidebar-width-icon": "4rem",
};

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
    <SidebarProvider
      style={sidebarStyle}
      className="surface-grain h-dvh min-h-0 overflow-hidden"
    >
      <SettingsSidebar isAdmin={isAdmin} />
      <SidebarInset className="surface-grain min-h-0 min-w-0 overflow-x-hidden overflow-y-auto">
        <header className="surface-grain sticky top-0 z-10 flex h-16 shrink-0 items-center gap-3 border-b border-border/40 bg-background px-4 md:px-6">
          <SidebarTrigger className="size-8 shrink-0 text-muted-foreground" />
          <Breadcrumb aria-label="Settings breadcrumb">
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink render={<Link href="/settings" />}>
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
        <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 md:px-6 lg:px-8 lg:py-8">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
