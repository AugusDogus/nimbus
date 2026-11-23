import type { CSSProperties, ReactNode } from "react";
import { createContext, useContext, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "@/components/link";
import { NimbusLogo } from "@/components/nimbus-logo";
import { NimbusWordmark } from "@/components/nimbus-wordmark";
import {
  Sidebar,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  useSidebar,
} from "@/components/ui/sidebar";

/** The sidebar's width open, and folded to its icons, in rem. */
const sidebarRem = { open: 16, icon: 4 } as const;

const sidebarStyle: CSSProperties & Record<`--${string}`, string> = {
  "--sidebar-width": `${sidebarRem.open}rem`,
  "--sidebar-width-icon": `${sidebarRem.icon}rem`,
};

/** Where the current section's navigation renders inside the sidebar, once it is on the page. */
const BodySlot = createContext<HTMLElement | null>(null);

/** The brand's look: the logo and wordmark, centred on the logo when the sidebar is folded. */
const brandClass =
  "flex h-12 items-center gap-3 rounded-xl px-2 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0";

function BrandMark() {
  return (
    <>
      <NimbusLogo className="size-8 shrink-0" />
      <NimbusWordmark className="group-data-[collapsible=icon]:hidden" />
    </>
  );
}

function Brand() {
  const { setOpenMobile } = useSidebar();
  return (
    <Link
      to="/"
      aria-label="Nimbus home"
      onClick={() => setOpenMobile(false)}
      data-shape="brand"
      className={brandClass}
    >
      <BrandMark />
    </Link>
  );
}

/**
 * The layout itself: the sidebar, with `brand` at its top and `sidebar` below it, and the page
 * area. The app's frame and the skeletons the server sends before the app runs are both this, so
 * nothing moves when the app takes over.
 */
function Layout({
  brand,
  sidebar,
  children,
}: {
  brand: ReactNode;
  sidebar: ReactNode;
  children: ReactNode;
}) {
  return (
    <SidebarProvider
      style={sidebarStyle}
      className="surface-grain h-dvh min-h-0 overflow-hidden"
    >
      <Sidebar collapsible="icon" variant="inset">
        <SidebarHeader className="h-16 justify-center px-3 group-data-[collapsible=icon]:px-0">
          {brand}
        </SidebarHeader>
        {sidebar}
      </Sidebar>
      {/* Phones scroll the page as one. From 768 px the area is the window's tint and never
          scrolls: the header sits on it and the content scrolls on its card (see `PageSurface`). */}
      <SidebarInset className="surface-grain min-h-0 min-w-0 overflow-x-hidden overflow-y-auto pb-(--impersonation-offset) [scrollbar-gutter:stable] md:overflow-hidden md:bg-none md:[scrollbar-gutter:auto] md:peer-data-[variant=inset]:rounded-none md:peer-data-[variant=inset]:bg-transparent md:peer-data-[variant=inset]:shadow-none">
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}

/**
 * The signed-in layout: one sidebar and one page area for the files pages and Settings alike, so
 * moving between them changes only what is inside, and the sidebar keeps its collapsed state.
 * Each section puts its navigation in the sidebar with `AppFrame.SidebarBody` and renders its
 * header and content as children.
 */
function Root({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <Layout
      brand={<Brand />}
      sidebar={<div ref={setSlot} className="contents" />}
    >
      <BodySlot.Provider value={slot}>{children}</BodySlot.Provider>
    </Layout>
  );
}

/** The brand as a skeleton shows it: the same look, not yet a link. */
function BrandPlaceholder() {
  return (
    <div data-shape="brand" className={brandClass}>
      <BrandMark />
    </div>
  );
}

/**
 * The section's navigation, rendered below the brand in the sidebar. On phones it renders only
 * while the sidebar sheet is open.
 */
function SidebarBody({ children }: { children: ReactNode }) {
  const slot = useContext(BodySlot);
  return slot ? createPortal(children, slot) : null;
}

export const AppFrame = {
  Root,
  SidebarBody,
  Layout,
  BrandPlaceholder,
  sidebarRem,
} as const;
