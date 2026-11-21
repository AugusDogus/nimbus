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

const sidebarStyle: CSSProperties & Record<`--${string}`, string> = {
  "--sidebar-width": "16rem",
  "--sidebar-width-icon": "4rem",
};

/** Where the current section's navigation renders inside the sidebar, once it is on the page. */
const BodySlot = createContext<HTMLElement | null>(null);

function Brand() {
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarHeader className="h-16 justify-center px-3 group-data-[collapsible=icon]:px-0">
      <Link
        to="/"
        aria-label="Nimbus home"
        onClick={() => setOpenMobile(false)}
        className="flex h-12 items-center gap-3 rounded-xl px-2 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
      >
        <NimbusLogo className="size-8 shrink-0" />
        <NimbusWordmark className="group-data-[collapsible=icon]:hidden" />
      </Link>
    </SidebarHeader>
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
    <SidebarProvider
      style={sidebarStyle}
      className="surface-grain h-dvh min-h-0 overflow-hidden"
    >
      <Sidebar collapsible="icon" variant="inset">
        <Brand />
        <div ref={setSlot} className="contents" />
      </Sidebar>
      <SidebarInset className="surface-grain min-h-0 min-w-0 overflow-x-hidden overflow-y-auto pb-(--impersonation-offset) [scrollbar-gutter:stable]">
        <BodySlot.Provider value={slot}>{children}</BodySlot.Provider>
      </SidebarInset>
    </SidebarProvider>
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

export const AppFrame = { Root, SidebarBody } as const;
