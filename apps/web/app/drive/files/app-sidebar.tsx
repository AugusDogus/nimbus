import { useState } from "react";
import { Link } from "@/components/link";
import { usePathname } from "@/hooks/use-pathname";
import {
  Clock,
  FolderPlus,
  HardDrive,
  Plus,
  Settings,
  Star,
  Trash2,
  FolderUp,
  Upload,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
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
import { NavPlace } from "./nav-place";

const navItems = [
  { icon: HardDrive, href: "/", place: "files" },
  { icon: Users, href: "/shared", place: "shared" },
  { icon: Clock, href: "/recent", place: "recent" },
  { icon: Star, href: "/starred", place: "starred" },
] as const;

type AppSidebarProps = {
  storage: StorageSummary;
  canWrite: boolean;
  /** Whether this page has a place to create in; Trash and a missing folder have none. */
  offersNew: boolean;
  isAdmin: boolean;
  newContent: NewContentState;
};

export function AppSidebar({
  storage,
  newContent,
  canWrite,
  offersNew,
  isAdmin,
}: AppSidebarProps) {
  const pathname = usePathname();
  const place = NavPlace.of(pathname);
  const { setOpenMobile } = useSidebar();
  // The menu closes, and stays closed, once this page cannot create, such as after Back to Trash.
  const creatable = canWrite && offersNew;
  const [menuOpen, setMenuOpen] = useState(false);
  if (!creatable && menuOpen) setMenuOpen(false);
  const closeNavigation = () => setOpenMobile(false);

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader className="h-16 justify-center px-3 group-data-[collapsible=icon]:px-0">
        <Link
          to="/"
          aria-label="Nimbus home"
          onClick={closeNavigation}
          className="flex h-12 items-center gap-3 rounded-xl px-2 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
        >
          <NimbusLogo className="size-8 shrink-0" />
          <NimbusWordmark className="group-data-[collapsible=icon]:hidden" />
        </Link>
      </SidebarHeader>

      <SidebarContent className="gap-4 px-3 pt-4 group-data-[collapsible=icon]:px-0">
        {/* Hidden in place, so the navigation below never moves between pages. */}
        <div className={cn("flex justify-center", !offersNew && "invisible")}>
          <DropdownMenu
            open={menuOpen}
            onOpenChange={(open) => setMenuOpen(open && creatable)}
          >
            <DropdownMenuTrigger
              render={
                <Button
                  size="lg"
                  aria-label="New"
                  title="New"
                  disabled={!canWrite}
                  className="h-12 w-full rounded-full bg-create text-create-foreground hover:bg-create/90 group-data-[collapsible=icon]:size-10 group-data-[collapsible=icon]:p-0"
                />
              }
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
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              sideOffset={8}
              className="w-48 rounded-xl p-1.5"
            >
              <DropdownMenuItem
                onClick={() => {
                  closeNavigation();
                  newContent.openFolderDialog();
                }}
              >
                <FolderPlus />
                New folder
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  closeNavigation();
                  newContent.triggerFileInput();
                }}
              >
                <Upload />
                Upload file
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  closeNavigation();
                  newContent.triggerFolderInput();
                }}
              >
                <FolderUp />
                Upload folder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <nav aria-label="Files">
          <SidebarMenu className="gap-1">
            {navItems.map((item) => {
              const active = item.place === place;
              const label = NavPlace.labels[item.place];
              return (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    isActive={active}
                    tooltip={label}
                    className="h-10 gap-3 rounded-xl px-3 group-data-[collapsible=icon]:mx-auto"
                    render={
                      <Link
                        to={item.href}
                        aria-current={active ? "page" : undefined}
                        onClick={closeNavigation}
                      />
                    }
                  >
                    <item.icon strokeWidth={1.7} />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </nav>
      </SidebarContent>

      <SidebarFooter className="gap-3 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-4 group-data-[collapsible=icon]:px-0">
        <SidebarMenu className="flex-row items-center justify-between gap-1 group-data-[collapsible=icon]:flex-col">
          <SidebarMenuItem className="min-w-0 flex-1 group-data-[collapsible=icon]:w-full group-data-[collapsible=icon]:flex-none">
            <SidebarMenuButton
              tooltip={NavPlace.labels.trash}
              isActive={place === "trash"}
              className="h-10 gap-3 rounded-xl px-3 group-data-[collapsible=icon]:mx-auto"
              render={
                <Link
                  to="/trash"
                  aria-current={place === "trash" ? "page" : undefined}
                  onClick={closeNavigation}
                />
              }
            >
              <Trash2 strokeWidth={1.7} />
              <span>{NavPlace.labels.trash}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem className="shrink-0 group-data-[collapsible=icon]:w-full">
            <SidebarMenuButton
              tooltip={NavPlace.labels.settings}
              isActive={place === "settings"}
              className="size-10 justify-center rounded-xl p-0 group-data-[collapsible=icon]:mx-auto"
              render={
                <Link
                  to="/settings"
                  aria-label={NavPlace.labels.settings}
                  title={NavPlace.labels.settings}
                  aria-current={place === "settings" ? "page" : undefined}
                  onClick={closeNavigation}
                />
              }
            >
              <Settings strokeWidth={1.7} />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {isAdmin && <StorageIndicator storage={storage} />}
      </SidebarFooter>
    </Sidebar>
  );
}
