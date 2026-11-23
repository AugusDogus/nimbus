import { useState, type ReactElement, type ReactNode } from "react";
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
import { PageLayout } from "@/components/page-layout";
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
  SidebarGroup,
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

type NavHref = (typeof navItems)[number]["href"] | "/trash" | "/settings";

/** The New button's look, in the create colour, as the sidebar and its skeleton draw it. */
const newButtonClass = cn("h-12 w-full rounded-full", PageLayout.createButton);

/**
 * The files pages' sidebar body: New, the places, and at the foot Trash, Settings and, for
 * administrators, the storage summary. `link` renders each place's link, or, in the skeleton the
 * server sends before the app runs, what stands in for it, so both have the same parts.
 */
function FilesNav({
  place,
  offersNew,
  isAdmin,
  storage,
  newButton,
  link,
}: {
  place: NavPlace | null;
  /** Hidden in place where there is nothing to create in, so the places never move. */
  offersNew: boolean;
  isAdmin: boolean;
  storage: StorageSummary;
  newButton: ReactNode;
  link: (href: NavHref, current: boolean) => ReactElement;
}) {
  return (
    <>
      <SidebarContent className="gap-4 px-1 pt-2">
        <div
          className={cn(
            "flex justify-center px-2",
            !offersNew && "invisible *:transition-none",
          )}
        >
          {newButton}
        </div>
        <nav aria-label="Files">
          <SidebarGroup>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    icon={item.icon}
                    isActive={item.place === place}
                    data-shape={`nav-${item.place}`}
                    render={link(item.href, item.place === place)}
                  >
                    {NavPlace.labels[item.place]}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        </nav>
      </SidebarContent>
      <SidebarFooter className="gap-3 px-1 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-4">
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                icon={Trash2}
                isActive={place === "trash"}
                data-shape="nav-trash"
                render={link("/trash", place === "trash")}
              >
                {NavPlace.labels.trash}
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                icon={Settings}
                isActive={place === "settings"}
                data-shape="nav-settings"
                render={link("/settings", place === "settings")}
              >
                {NavPlace.labels.settings}
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        {isAdmin && (
          <div className="px-2">
            <StorageIndicator storage={storage} />
          </div>
        )}
      </SidebarFooter>
    </>
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
  const creatable = canWrite && offersNew;
  const [menuOpen, setMenuOpen] = useState(false);
  if (!creatable && menuOpen) setMenuOpen(false);
  const closeNavigation = () => setOpenMobile(false);

  return (
    <FilesNav
      place={place}
      offersNew={offersNew}
      isAdmin={isAdmin}
      storage={storage}
      link={(href, current) => (
        <Link
          to={href}
          aria-current={current ? "page" : undefined}
          onClick={closeNavigation}
        />
      )}
      newButton={
        <DropdownMenu
          open={menuOpen}
          onOpenChange={(open) => setMenuOpen(open && creatable)}
        >
          <DropdownMenuTrigger
            render={
              <Button
                leadingIcon={Plus}
                aria-label="New"
                title="New"
                disabled={!canWrite}
                data-shape="new"
                className={newButtonClass}
              />
            }
          >
            New
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
      }
    />
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
  return (
    <FilesNav
      place={place}
      offersNew={offersNew}
      isAdmin={isAdmin}
      storage={{ status: "loading" }}
      link={() => <div />}
      newButton={
        <Button
          leadingIcon={Plus}
          tabIndex={-1}
          data-shape="new"
          className={newButtonClass}
        >
          New
        </Button>
      }
    />
  );
}
