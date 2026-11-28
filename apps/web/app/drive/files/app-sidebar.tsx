import { useId, useState, type ReactElement, type ReactNode } from "react";
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
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  DropdownContent,
  DropdownMenu,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import { MenuItem } from "@/components/ui/menu-item";
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
import { NewButton } from "./new-button";
import { NewTarget } from "./new-target";

const navItems = [
  { icon: HardDrive, href: "/", place: "files" },
  { icon: Users, href: "/shared", place: "shared" },
  { icon: Clock, href: "/recent", place: "recent" },
  { icon: Star, href: "/starred", place: "starred" },
] as const;

type NavHref = (typeof navItems)[number]["href"] | "/trash" | "/settings";

/**
 * The files pages' sidebar body: New, on every files page so the sidebar keeps its shape, the
 * places, and at the foot Trash, Settings and, for administrators, the storage summary. `link` renders each place's link, or, in the skeleton the
 * server sends before the app runs, what stands in for it, so both have the same parts.
 */
function FilesNav({
  place,
  isAdmin,
  storage,
  newButton,
  link,
}: {
  place: NavPlace | null;
  isAdmin: boolean;
  storage: StorageSummary;
  newButton: ReactNode;
  link: (href: NavHref, current: boolean) => ReactElement;
}) {
  return (
    <>
      <SidebarContent className="gap-4 px-1 pt-2">
        <div className="flex justify-center px-2">{newButton}</div>
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
  /** Where New creates from this page (see `NewTarget`). */
  newTarget: NewTarget;
  /** Says why New has nowhere to create, when pressed then. */
  onExplainNew: () => void;
  isAdmin: boolean;
  newContent: NewContentState;
};

export function AppSidebar({
  storage,
  newContent,
  newTarget,
  onExplainNew,
  isAdmin,
}: AppSidebarProps) {
  const pathname = usePathname();
  const place = NavPlace.of(pathname);
  const { setOpenMobile } = useSidebar();
  const reasonId = useId();
  const target = NewTarget.path(newTarget);
  // The folder the open menu creates in; it closes once the page creates elsewhere.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  if (menuFor !== null && menuFor !== target) setMenuFor(null);
  const closeNavigation = () => setOpenMobile(false);
  const state = NewButton.state(newTarget);

  return (
    <FilesNav
      place={place}
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
        newTarget.kind === "none" ? (
          <>
            <Tooltip content={newTarget.reason} side="right">
              <Button
                leadingIcon={Plus}
                aria-label="New"
                aria-describedby={reasonId}
                data-shape="new"
                {...state}
                className={cn(NewButton.looks.sidebar, state.className)}
                onClick={onExplainNew}
              >
                New
              </Button>
            </Tooltip>
            <span id={reasonId} className="sr-only">
              {newTarget.reason}
            </span>
          </>
        ) : (
          <DropdownMenu
            open={menuFor !== null}
            onOpenChange={(open) => setMenuFor(open ? target : null)}
          >
            <DropdownTrigger
              render={
                <Button
                  leadingIcon={Plus}
                  aria-label="New"
                  title="New"
                  data-shape="new"
                  {...state}
                  className={cn(NewButton.looks.sidebar, state.className)}
                />
              }
            >
              New
            </DropdownTrigger>
            <DropdownContent align="start" sideOffset={8} className="w-48">
              <MenuItem
                index={0}
                icon={FolderPlus}
                label="New folder"
                onSelect={() => {
                  closeNavigation();
                  newContent.openFolderDialog();
                }}
              />
              <MenuItem
                index={1}
                icon={Upload}
                label="Upload file"
                onSelect={() => {
                  closeNavigation();
                  newContent.triggerFileInput();
                }}
              />
              <MenuItem
                index={2}
                icon={FolderUp}
                label="Upload folder"
                onSelect={() => {
                  closeNavigation();
                  newContent.triggerFolderInput();
                }}
              />
            </DropdownContent>
          </DropdownMenu>
        )
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
  isAdmin,
}: {
  place: NavPlace | null;
  isAdmin: boolean;
}) {
  return (
    <FilesNav
      place={place}
      isAdmin={isAdmin}
      storage={{ status: "loading" }}
      link={() => <div />}
      newButton={
        <Button
          leadingIcon={Plus}
          tabIndex={-1}
          data-shape="new"
          className={NewButton.looks.sidebar}
        >
          New
        </Button>
      }
    />
  );
}
