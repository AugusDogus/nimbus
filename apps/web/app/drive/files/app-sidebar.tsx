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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarContent,
  SidebarFooter,
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

/**
 * The sidebar's parts, which `AppSidebar` and its skeleton (`AppSidebarPlaceholder`) share, so the
 * skeleton the server sends before the app runs keeps step with it.
 */
const parts = {
  content: "gap-4 px-3 pt-4 group-data-[collapsible=icon]:px-0",
  /** Hidden in place, so the navigation below never moves between pages. */
  newPlace: (offersNew: boolean) =>
    cn("flex justify-center", !offersNew && "invisible *:transition-none"),
  newButton:
    "h-12 w-full rounded-full bg-create text-create-foreground hover:bg-create/90 group-data-[collapsible=icon]:size-10 group-data-[collapsible=icon]:p-0",
  newIcon:
    "absolute right-full mr-2 size-5 group-data-[collapsible=icon]:static group-data-[collapsible=icon]:mr-0",
  menu: "gap-1",
  navButton: "h-10 gap-3 rounded-xl px-3 group-data-[collapsible=icon]:mx-auto",
  footer:
    "gap-3 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-4 group-data-[collapsible=icon]:px-0",
  footerMenu:
    "flex-row items-center justify-between gap-1 group-data-[collapsible=icon]:flex-col",
  trashItem:
    "min-w-0 flex-1 group-data-[collapsible=icon]:w-full group-data-[collapsible=icon]:flex-none",
  settingsItem: "shrink-0 group-data-[collapsible=icon]:w-full",
  settingsButton:
    "size-10 justify-center rounded-xl p-0 group-data-[collapsible=icon]:mx-auto",
} as const;

function NewLabel() {
  return (
    <span className="relative flex items-center">
      <Plus className={parts.newIcon} strokeWidth={1.8} />
      <span className="group-data-[collapsible=icon]:hidden">New</span>
    </span>
  );
}

type AppSidebarProps = {
  storage: StorageSummary;
  canWrite: boolean;
  /**
   * Whether this page is a folder to create in. Trash, Recent, Starred, Shared, search, and a
   * missing or refused folder are not.
   */
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
    <>
      <SidebarContent className={parts.content}>
        {/* The button's transition would otherwise keep it visible for a moment after the page
            changes. */}
        <div className={parts.newPlace(offersNew)}>
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
                  data-shape="new"
                  className={parts.newButton}
                />
              }
            >
              <NewLabel />
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
          <SidebarMenu className={parts.menu}>
            {navItems.map((item) => {
              const active = item.place === place;
              const label = NavPlace.labels[item.place];
              return (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    isActive={active}
                    tooltip={label}
                    data-shape={`nav-${item.place}`}
                    className={parts.navButton}
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

      <SidebarFooter className={parts.footer}>
        <SidebarMenu className={parts.footerMenu}>
          <SidebarMenuItem className={parts.trashItem}>
            <SidebarMenuButton
              tooltip={NavPlace.labels.trash}
              isActive={place === "trash"}
              data-shape="nav-trash"
              className={parts.navButton}
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
          <SidebarMenuItem className={parts.settingsItem}>
            <SidebarMenuButton
              tooltip={NavPlace.labels.settings}
              isActive={place === "settings"}
              data-shape="nav-settings"
              className={parts.settingsButton}
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
    </>
  );
}

/**
 * The sidebar as a page's skeleton shows it, before the app runs: the same parts in the same
 * places, not yet links or menus, with the storage summary still to come.
 */
export function AppSidebarPlaceholder({
  place,
  offersNew,
  isAdmin,
}: {
  place: NavPlace | null;
  offersNew: boolean;
  isAdmin: boolean;
}) {
  const item = (
    navPlace: NavPlace,
    Icon: (typeof navItems)[number]["icon"] | typeof Trash2,
  ) => (
    <SidebarMenuButton
      isActive={navPlace === place}
      data-shape={`nav-${navPlace}`}
      className={parts.navButton}
      render={<div />}
    >
      <Icon strokeWidth={1.7} />
      <span>{NavPlace.labels[navPlace]}</span>
    </SidebarMenuButton>
  );
  return (
    <>
      <SidebarContent className={parts.content}>
        <div className={parts.newPlace(offersNew)}>
          <Button
            size="lg"
            tabIndex={-1}
            data-shape="new"
            className={parts.newButton}
          >
            <NewLabel />
          </Button>
        </div>
        <SidebarMenu className={parts.menu}>
          {navItems.map((navItem) => (
            <SidebarMenuItem key={navItem.href}>
              {item(navItem.place, navItem.icon)}
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarContent>
      <SidebarFooter className={parts.footer}>
        <SidebarMenu className={parts.footerMenu}>
          <SidebarMenuItem className={parts.trashItem}>
            {item("trash", Trash2)}
          </SidebarMenuItem>
          <SidebarMenuItem className={parts.settingsItem}>
            <SidebarMenuButton
              isActive={place === "settings"}
              data-shape="nav-settings"
              className={parts.settingsButton}
              render={<div />}
            >
              <Settings strokeWidth={1.7} />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {isAdmin && <StorageIndicator storage={{ status: "loading" }} />}
      </SidebarFooter>
    </>
  );
}
