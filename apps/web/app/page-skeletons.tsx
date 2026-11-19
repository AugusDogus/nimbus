import { Clock, HardDrive, House, Star, Trash2, Users } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { NimbusLogo } from "@/components/nimbus-logo";
import { NimbusWordmark } from "@/components/nimbus-wordmark";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingSkeleton } from "./drive/files/loading-skeleton";

/**
 * What a page shows before its code runs. The server sends one of these inside `#root`; the app
 * replaces it once the first route has its code and data. Each uses the classes of the layout
 * it stands in for, so nothing moves when the app takes over, and CSS alone adapts it to the
 * viewport. These are pure components: the server renders them once at startup.
 */

const sidebarStyle: CSSProperties = {
  "--sidebar-width": "16rem",
  "--sidebar-width-icon": "4rem",
};

const navItems = [
  { icon: House, label: "My files" },
  { icon: HardDrive, label: "My Drive" },
  { icon: Users, label: "Shared" },
  { icon: Clock, label: "Recent" },
  { icon: Star, label: "Starred" },
];

/** The inset sidebar layout of signed-in pages, as `SidebarProvider` and `Sidebar` render it. */
function SidebarFrame({
  sidebar,
  children,
}: {
  sidebar: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      data-slot="sidebar-wrapper"
      style={sidebarStyle}
      className="group/sidebar-wrapper has-data-[variant=inset]:bg-sidebar flex min-h-svh w-full surface-grain h-dvh min-h-0 overflow-hidden"
    >
      <div
        className="group peer text-sidebar-foreground hidden md:block"
        data-state="expanded"
        data-collapsible=""
        data-variant="inset"
        data-side="left"
        data-slot="sidebar"
      >
        <div className="relative w-(--sidebar-width) bg-transparent" />
        <div className="fixed inset-y-0 left-0 z-10 hidden h-svh w-(--sidebar-width) p-2 md:flex">
          <div
            data-sidebar="sidebar"
            className="bg-sidebar flex h-full w-full flex-col"
          >
            <div className="flex h-16 flex-col justify-center gap-2 p-2 px-3">
              <div className="flex h-12 items-center gap-3 rounded-xl px-2 text-foreground">
                <NimbusLogo className="size-8 shrink-0" />
                <NimbusWordmark />
              </div>
            </div>
            {sidebar}
          </div>
        </div>
      </div>
      <main
        data-slot="sidebar-inset"
        className="bg-background relative flex w-full flex-1 flex-col md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm surface-grain min-h-0 min-w-0 overflow-x-hidden overflow-y-auto"
      >
        {children}
      </main>
    </div>
  );
}

function NavLabel({ icon: Icon, label }: (typeof navItems)[number]) {
  return (
    <div className="flex h-10 w-full items-center gap-3 overflow-hidden rounded-xl p-2 px-3 text-left text-sm [&>svg]:size-4 [&>svg]:shrink-0">
      <Icon strokeWidth={1.7} />
      <span className="truncate">{label}</span>
    </div>
  );
}

/**
 * The file browser before it loads: sidebar and header, and for a folder its toolbar and
 * placeholder entries. Other file pages, such as Trash, keep their content area empty.
 */
export function FilesSkeleton({ view }: { view: "list" | "grid" | null }) {
  return (
    <SidebarFrame
      sidebar={
        <>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-3 pt-4">
            <div className="flex justify-center">
              <div className="h-12 w-full rounded-full bg-create" />
            </div>
            <div className="flex w-full min-w-0 flex-col gap-1">
              {navItems.map((item) => (
                <NavLabel key={item.label} {...item} />
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-3 p-2 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-4">
            <div className="flex w-full min-w-0 flex-row items-center justify-between gap-1">
              <div className="min-w-0 flex-1">
                <NavLabel icon={Trash2} label="Trash" />
              </div>
              <Skeleton className="size-10 shrink-0 rounded-xl" />
            </div>
          </div>
        </>
      }
    >
      <header className="surface-grain sticky top-0 z-20 flex h-16 shrink-0 items-center justify-between gap-2 border-b border-border/40 bg-background px-4 md:gap-4 md:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-2 max-md:pointer-coarse:gap-3.5 md:gap-4">
          <Skeleton className="size-8 shrink-0" />
          <NimbusLogo className="size-7 shrink-0 md:hidden" />
          <div className="relative min-w-0 max-w-lg flex-1">
            <div className="h-9 rounded-lg bg-muted/70 md:h-10 dark:bg-sidebar/70" />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 md:gap-3">
          <Skeleton className="size-9 rounded-full" />
        </div>
      </header>
      <div className="flex-1 overflow-x-clip px-4 pb-24 pt-6 md:px-6 md:pb-6 lg:px-8 lg:pt-8">
        {view && <FolderPlaceholder view={view} />}
      </div>
    </SidebarFrame>
  );
}

function FolderPlaceholder({ view }: { view: "list" | "grid" }) {
  return (
    <>
      <div className="surface-grain sticky top-16 z-10 -mx-4 -mt-6 mb-6 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border/70 bg-background px-4 py-3 md:-mx-6 md:flex md:justify-between md:px-6 lg:-mx-8 lg:-mt-8 lg:px-8">
        <div className="flex h-10 min-w-0 items-center gap-2 overflow-hidden">
          <Skeleton className="h-6 w-28 max-w-[38vw]" />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Skeleton className="size-8 rounded md:hidden" />
          <Skeleton className="size-8 rounded md:hidden" />
          <div className="hidden items-center gap-2 md:flex">
            <Skeleton className="h-8 w-36 rounded" />
            <Skeleton className="size-8 rounded" />
            <Skeleton className="h-8 w-16 rounded" />
          </div>
        </div>
      </div>
      <LoadingSkeleton view={view} />
    </>
  );
}

/** Settings before they load: the sidebar frame, the breadcrumb header and a section outline. */
export function SettingsSkeleton() {
  return (
    <SidebarFrame
      sidebar={
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pt-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-10 w-full rounded-xl" />
          ))}
        </div>
      }
    >
      <header className="surface-grain sticky top-0 z-10 flex h-16 shrink-0 items-center gap-3 border-b border-border/40 bg-background px-4 md:px-6">
        <Skeleton className="size-8 shrink-0" />
        <Skeleton className="h-4 w-40" />
      </header>
      <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 md:px-6 lg:px-8 lg:py-8">
        <div className="space-y-8">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      </div>
    </SidebarFrame>
  );
}
