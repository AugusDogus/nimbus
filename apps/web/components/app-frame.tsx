import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Link } from "@/components/link";
import { NimbusLogo } from "@/components/nimbus-logo";
import { NimbusWordmark } from "@/components/nimbus-wordmark";
import {
  SIDEBAR_COOKIE_MAX_AGE,
  SIDEBAR_COOKIE_NAME,
  Sidebar,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  useSidebar,
} from "@/components/ui/sidebar";

/** The sidebar's width open, in rem; collapsed, it slides away entirely. */
const sidebarRem = 16;

/**
 * Whether the person keeps the sidebar open, in the cookie Fluid Functionalism's sidebar names,
 * which the server reads too so a page's skeleton shows the sidebar as the page will.
 */
const SidebarChoice = {
  cookie: SIDEBAR_COOKIE_NAME,
  /** Open unless the cookie says closed. */
  fromCookie: (cookie: string | null) =>
    !(cookie ?? "")
      .split(";")
      .some((part) => part.trim() === `${SIDEBAR_COOKIE_NAME}=false`),
  remember(open: boolean) {
    document.cookie = `${SIDEBAR_COOKIE_NAME}=${open}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}; samesite=lax`;
  },
} as const;

/**
 * A fold of the sidebar that is not the person's choice, such as a split view's to make room for
 * its panes: it closes the sidebar without being remembered, and their own toggle ends it.
 */
type Fold = { folded: boolean; setFolded: (folded: boolean) => void };
const FoldContext = createContext<Fold>({
  folded: false,
  setFolded: () => undefined,
});

/**
 * Where the current section's navigation renders inside the sidebar. On phones the sidebar has two
 * places for it, its hidden column and, while open, its drawer: the drawer's wins while it is up.
 */
const BodySlot = createContext<HTMLElement | null>(null);

function useBodySlot() {
  const [slots, setSlots] = useState<readonly HTMLElement[]>([]);
  const attach = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    setSlots((current) => [...current, element]);
    return () =>
      setSlots((current) => current.filter((each) => each !== element));
  }, []);
  const slot =
    slots.find((each) => each.closest('[role="dialog"]') !== null) ??
    slots[0] ??
    null;
  return { slot, attach };
}

/** The brand's look: the logo and the wordmark. */
const brandClass =
  "flex h-12 items-center gap-3 rounded-xl px-2 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";

function BrandMark() {
  return (
    <>
      <NimbusLogo className="size-8 shrink-0" />
      <NimbusWordmark />
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
 * The layout itself: Fluid Functionalism's sidebar, with `brand` at its top and `sidebar` below
 * it, and the page area. The app's frame and the skeletons the server sends before the app runs
 * are both this, so nothing moves when the app takes over.
 *
 * The page area sits on the window's tint, as the sidebar does, and draws its own cards; its 8 px
 * margin stays the same open or closed, so the page moves only with the sidebar's own motion.
 */
function Layout({
  open,
  onOpenChange,
  brand,
  sidebar,
  children,
}: {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  brand: ReactNode;
  sidebar: ReactNode;
  children: ReactNode;
}) {
  return (
    <SidebarProvider
      open={open}
      onOpenChange={onOpenChange}
      // Nimbus remembers the person's choice itself, apart from a split view's fold.
      persist={false}
      peek="hover"
      width={`${sidebarRem}rem`}
      className="surface-grain h-dvh min-h-0 overflow-hidden"
    >
      <Sidebar variant="sidebar" bordered={false} rail={false}>
        <SidebarHeader className="h-16 justify-center px-3 py-0">
          {brand}
        </SidebarHeader>
        {sidebar}
      </Sidebar>
      {/* Phones scroll the page as one. From 768 px the area is the window's tint and never
          scrolls: the header sits on it and the content scrolls on its card (see `PageSurface`). */}
      <SidebarInset className="surface-grain min-h-0 min-w-0 overflow-x-hidden overflow-y-auto pb-(--impersonation-offset) [scrollbar-gutter:stable] md:m-2 md:overflow-hidden md:bg-transparent md:bg-none md:[scrollbar-gutter:auto]">
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}

/**
 * The signed-in layout: one sidebar and one page area for the files pages and Settings alike, so
 * moving between them changes only what is inside, and the sidebar stays as it was. Each section
 * puts its navigation in the sidebar with `AppFrame.SidebarBody` and renders its header and
 * content as children.
 */
function Root({ children }: { children: ReactNode }) {
  const [chosen, setChosen] = useState(() =>
    SidebarChoice.fromCookie(document.cookie),
  );
  const [folded, setFolded] = useState(false);
  const { slot, attach } = useBodySlot();
  const fold = useMemo(() => ({ folded, setFolded }), [folded]);
  return (
    <FoldContext.Provider value={fold}>
      <Layout
        open={chosen && !folded}
        onOpenChange={(open) => {
          // The person's own toggle: theirs from now on, also over a fold.
          setChosen(open);
          setFolded(false);
          SidebarChoice.remember(open);
        }}
        brand={<Brand />}
        sidebar={<div ref={attach} className="contents" />}
      >
        <BodySlot.Provider value={slot}>{children}</BodySlot.Provider>
      </Layout>
    </FoldContext.Provider>
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

/** The section's navigation, rendered below the brand in the sidebar. */
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
  SidebarChoice,
  /** The split view's channel for folding the sidebar without it being remembered. */
  useFold: () => useContext(FoldContext),
} as const;
