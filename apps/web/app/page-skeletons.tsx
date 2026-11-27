import type { UserPreferences } from "@nimbus/api/context";
import { Search } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { AppFrame, type SidebarChoice } from "@/components/app-frame";
import { NimbusLogo } from "@/components/nimbus-logo";
import { PageLayout } from "@/components/page-layout";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { AppSidebarPlaceholder } from "./drive/files/app-sidebar";
import { FiltersRow, folderFilters } from "./drive/files/filters-row";
import { FolderCard } from "./drive/files/folder-card";
import { EntrySkeleton } from "./drive/files/loading-skeleton";
import type { NavPlace } from "./drive/files/nav-place";
import { AloneFolderTools, SplitToggle } from "./drive/files/split-toggle";
import { SearchField } from "./drive/search/search-field";
import type { ListPage } from "./drive/files/list-order";
import { ListHeader, listFilters } from "./drive/list-filters";
import { SharedFrame, type SharedTab } from "./drive/shared/shared-frame";
import {
  FileRequestsPending,
  PublicLinksPending,
} from "./drive/shared/shared-pending";
import {
  TrashIntro,
  TrashShape,
  TrashSkeleton,
  trashFilters,
} from "./drive/trash/trash-shape";
import {
  SettingsSidebarPlaceholder,
  settingsPages,
} from "./settings/settings-sidebar";

/**
 * What a page shows before its code runs. The server sends one of these inside `#root`; the app
 * replaces it once the first route has its code and data. Each is built from the parts the page
 * itself uses (the frame, the sidebar's parts, the header's, the folder card, the sort and view
 * controls) so nothing moves when the app takes over, and CSS alone adapts it to the viewport.
 * They are pure components, rendered by the server for what it knows of the page.
 */

const bar = "motion-reduce:animate-none";
const nothing = () => undefined;

/**
 * What the app measures as its header moves (see `useHeaderEdges`), here from the sidebar's state
 * and the header's own parts: the toggle on the left, and on the right the account menu, after
 * the split view's toggle on a folder (`--end-w`).
 */
function headerEdges(
  sidebar: SidebarChoice,
): CSSProperties & Record<`--${string}`, string> {
  return {
    "--header-left": sidebar.open
      ? `calc(${sidebar.width}px + 0.5rem)`
      : "0.5rem",
    "--start-edge":
      "calc(var(--header-left) + var(--header-pad, 0px) + 2rem + 1rem)",
    "--end-edge":
      "calc(100vw - 0.5rem - var(--header-pad, 0px) - var(--end-w) - 1rem)",
  };
}

/** Who is signed in, as far as the skeleton shows it. */
export type SkeletonAccount = {
  initial: string;
  isAdmin: boolean;
  /** How the person keeps the sidebar (see `AppFrame.SidebarChoice`). */
  sidebar: SidebarChoice;
};

function AccountButton({ initial }: { initial: string }) {
  return (
    <Button
      variant="ghost"
      tabIndex={-1}
      data-shape="account"
      className={PageLayout.account}
    >
      <Avatar>
        <AvatarFallback className={PageLayout.avatarFallback}>
          {initial}
        </AvatarFallback>
      </Avatar>
    </Button>
  );
}

/** A title's line, such as a page's, still to come. */
function PendingTitle() {
  return (
    <div
      data-shape="page-title"
      className={cn(PageLayout.title, "flex h-8 items-center")}
    >
      <Skeleton className={cn("h-6 w-36", bar)} />
    </div>
  );
}

/**
 * What a files page other than a folder shows first: Trash its own items; Recent, Starred and
 * search their title, sort and view controls and entries; and Shared its title and tabs, with
 * the chosen tab's own: for files shared with you their controls and entries.
 */
export type FilesPageSkeleton = "trash" | ListPage;

/**
 * A files page before it loads: the sidebar and header, and for a folder its card, with the
 * sort and view controls as the account set them, and placeholder entries. Other files pages
 * show their card with what they start with (see `FilesPageSkeleton`).
 */
export function FilesSkeleton({
  account,
  place,
  page,
}: {
  account: SkeletonAccount;
  place: NavPlace | null;
  page:
    | { kind: "folder"; prefs: UserPreferences }
    | {
        kind: "page";
        shows: FilesPageSkeleton;
        /** The account's view, and the order the address names, if any. */
        view: UserPreferences["view"];
        sort: string | undefined;
        /** The page's title where the server knows it, as a search's; a placeholder otherwise. */
        title?: string;
        /** Shared's tab, from the address. */
        tab: SharedTab;
      };
}) {
  const folder = page.kind === "folder";
  return (
    <AppFrame.Layout
      open={account.sidebar.open}
      width={account.sidebar.width}
      brand={<AppFrame.BrandPlaceholder />}
      sidebar={
        <AppSidebarPlaceholder
          place={place}
          offersNew={folder}
          isAdmin={account.isAdmin}
        />
      }
    >
      <header
        data-shape="header"
        className={cn(
          PageLayout.filesHeader,
          // A folder's header holds the split view's toggle too.
          folder ? "[--end-w:4.75rem]" : "[--end-w:2.25rem]",
        )}
        style={headerEdges(account.sidebar)}
      >
        <div className={PageLayout.filesHeaderStart}>
          <SidebarTrigger
            tabIndex={-1}
            data-shape="sidebar-trigger"
            className={PageLayout.sidebarTrigger}
          />
          <NimbusLogo className={cn(PageLayout.logo, "shrink-0 md:hidden")} />
        </div>
        <div className={SearchField.form}>
          <Search className={SearchField.icon} />
          <Input
            readOnly
            tabIndex={-1}
            placeholder={SearchField.placeholder}
            data-shape="search"
            className={SearchField.input}
          />
        </div>
        <div className={PageLayout.filesHeaderEnd}>
          {folder && <SplitToggle open={false} onToggle={nothing} />}
          <AccountButton initial={account.initial} />
        </div>
      </header>
      <div
        data-slot={folder ? undefined : "page-card"}
        className={PageLayout.filesContent(folder)}
      >
        {page.kind === "folder" ? (
          <FolderCard
            pane={null}
            attachToolbar={nothing}
            moves={{ back: null, up: null }}
            breadcrumbs={
              <div className="flex h-5 items-center sm:h-6">
                <Skeleton className={cn("h-4 w-32 max-w-[38vw]", bar)} />
              </div>
            }
            tools={
              <AloneFolderTools
                filters={folderFilters(page.prefs, nothing)}
                onSplit={nothing}
              />
            }
            body={<EntrySkeleton view={page.prefs.view} />}
          />
        ) : page.shows === "trash" ? (
          <div className="space-y-6">
            <div className={TrashShape.header}>
              <TrashIntro />
              <div className={TrashShape.tools}>
                <FiltersRow {...trashFilters(page.sort, nothing)} />
                <Button variant="tertiary" disabled tabIndex={-1}>
                  {TrashShape.emptyLabel}
                </Button>
              </div>
            </div>
            <TrashSkeleton />
          </div>
        ) : page.shows !== "shared" ? (
          <div className="space-y-6">
            <ListHeader
              title={
                page.title === undefined ? (
                  <PendingTitle />
                ) : (
                  <h1 className={PageLayout.title}>{page.title}</h1>
                )
              }
              filters={listFilters(page.shows, page.sort, page.view, {
                order: nothing,
                view: nothing,
              })}
            />
            <EntrySkeleton view={page.view} titled={false} />
          </div>
        ) : (
          <SharedFrame tab={page.tab} onTab={nothing}>
            <TabsContent value={page.tab}>
              {page.tab === "with-me" ? (
                <div className="space-y-6">
                  <ListHeader
                    title={false}
                    filters={listFilters("shared", page.sort, page.view, {
                      order: nothing,
                      view: nothing,
                    })}
                  />
                  <EntrySkeleton view={page.view} titled={false} />
                </div>
              ) : page.tab === "links" ? (
                <PublicLinksPending />
              ) : (
                <FileRequestsPending />
              )}
            </TabsContent>
          </SharedFrame>
        )}
      </div>
    </AppFrame.Layout>
  );
}

/**
 * Settings before they load: the sidebar, the breadcrumb header with the page's name, and the
 * page's title.
 */
export function SettingsSkeleton({
  account,
  path,
}: {
  account: SkeletonAccount;
  path: string;
}) {
  const page = settingsPages.find((each) => each.href === path);
  const trail: ReactNode = (
    <Breadcrumb data-shape="settings-trail">
      <BreadcrumbList>
        <BreadcrumbItem>Settings</BreadcrumbItem>
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
  );
  return (
    <AppFrame.Layout
      open={account.sidebar.open}
      width={account.sidebar.width}
      brand={<AppFrame.BrandPlaceholder />}
      sidebar={
        <SettingsSidebarPlaceholder
          isAdmin={account.isAdmin}
          current={page?.href ?? null}
        />
      }
    >
      <header data-shape="header" className={PageLayout.settingsHeader}>
        <SidebarTrigger
          tabIndex={-1}
          data-shape="sidebar-trigger"
          className={PageLayout.sidebarTrigger}
        />
        {trail}
      </header>
      <div data-slot="page-card" className={PageLayout.settingsContent}>
        <div className={PageLayout.settingsColumn}>
          <PendingTitle />
        </div>
      </div>
    </AppFrame.Layout>
  );
}
