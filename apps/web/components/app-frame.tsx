import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Link } from "@/components/link";
import { NimbusLogo } from "@/components/nimbus-logo";
import { NimbusWordmark } from "@/components/nimbus-wordmark";
import { Device } from "@/lib/device";
import {
  SIDEBAR_COOKIE_MAX_AGE,
  SIDEBAR_COOKIE_NAME,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  Sidebar,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  useSidebar,
} from "@/components/ui/sidebar";

/**
 * Whether the person keeps the sidebar open, and how wide they dragged it, in pixels; collapsed,
 * it slides away entirely.
 */
export type SidebarChoice = { open: boolean; width: number };

const widthCookie = "sidebar_width";

function cookieValue(cookie: string | null, name: string) {
  for (const part of (cookie ?? "").split(";")) {
    const [key, value] = part.trim().split("=");
    if (key === name) return value;
  }
  return undefined;
}

function remember(name: string, value: string) {
  document.cookie = `${name}=${value}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}; samesite=lax`;
}

/**
 * The person's choice, in the cookie Fluid Functionalism's sidebar names for whether it is open
 * and a sibling for its width, which the server reads too so a page's skeleton shows the sidebar
 * as the page will.
 */
const SidebarChoice = {
  cookie: SIDEBAR_COOKIE_NAME,
  widthCookie,
  /** 16 rem, as the sidebar comes. */
  defaultWidth: 256,
  /** Open unless the cookie says closed, as wide as it says within the rail's bounds. */
  fromCookie(cookie: string | null): SidebarChoice {
    const width = Number(cookieValue(cookie, widthCookie));
    return {
      open: cookieValue(cookie, SIDEBAR_COOKIE_NAME) !== "false",
      width: Number.isFinite(width)
        ? Math.min(
            SIDEBAR_MAX_WIDTH,
            Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)),
          )
        : SidebarChoice.defaultWidth,
    };
  },
  remember: (open: boolean) => remember(SIDEBAR_COOKIE_NAME, String(open)),
  rememberWidth: (width: number) => remember(widthCookie, String(width)),
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

/** The sidebar's width open, in pixels, as the rail drags it. */
const WidthContext = createContext<number>(SidebarChoice.defaultWidth);

/**
 * Whether the sidebar is sliding open or closed, from the moment it is told to until its column
 * reaches its new width. The page moves with it frame by frame; what would rearrange on each of
 * those frames, such as the grid's columns, can wait for it instead (see `useGridTrack`).
 */
const MotionContext = createContext(false);

function useSidebarMotion(open: boolean, width: number) {
  const [moving, setMoving] = useState(false);
  const [settledOpen, setSettledOpen] = useState(open);
  if (settledOpen !== open) {
    setSettledOpen(open);
    setMoving(true);
  }
  useEffect(() => {
    if (!moving) return;
    const column = document.querySelector('[data-slot="sidebar"]');
    const target = open ? width : 0;
    const done = () => setMoving(false);
    const check = () => {
      if (
        column &&
        Math.abs(column.getBoundingClientRect().width - target) < 0.5
      )
        done();
    };
    const observer = new ResizeObserver(check);
    if (column) observer.observe(column);
    // A sidebar out of view, as on a phone, never reaches its width.
    const fallback = setTimeout(done, 1000);
    return () => {
      observer.disconnect();
      clearTimeout(fallback);
    };
  }, [moving, open, width]);
  return moving;
}

/**
 * Follows the width the rail gives the sidebar, and remembers it once a drag ends; a key press on
 * the rail ends its change at once.
 */
function WidthWatch({
  saved,
  onChange,
}: {
  saved: number;
  onChange: (width: number) => void;
}) {
  const { width, isResizing } = useSidebar();
  // The rail sets whole pixels; the frame gives it pixels too.
  const px = Number.parseFloat(width);
  const remembered = useRef(saved);
  useLayoutEffect(() => {
    if (!Number.isFinite(px)) return;
    onChange(px);
    if (isResizing || px === remembered.current) return;
    remembered.current = px;
    SidebarChoice.rememberWidth(px);
  }, [px, isResizing, onChange]);
  return null;
}

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
  width,
  onOpenChange,
  brand,
  sidebar,
  children,
}: {
  open: boolean;
  /** The width it opens at, in pixels; the rail changes it from there. */
  width: number;
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
      // The sidebar becomes a drawer where the window is narrow, by the one rule for that.
      mobileBreakpoint={Device.narrowBelow}
      // No peek: the collapsed sidebar would float in over the toggle, which sits at the
      // content's edge, so the toggle could not be reached to open it.
      peek="none"
      width={`${width}px`}
      // The window's tint, which the sidebar and the header share and the content's cards
      // stand on.
      className="surface-grain h-dvh min-h-0 overflow-hidden bg-sidebar"
    >
      <Sidebar
        variant="sidebar"
        bordered={false}
        // Their column fades in where it first appears, meant for a window widening past the
        // drawer's breakpoint; here it would fade in over the page's skeleton on every load.
        className="md:starting:opacity-100"
      >
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
  const [saved] = useState(() => SidebarChoice.fromCookie(document.cookie));
  const [chosen, setChosen] = useState(saved.open);
  const [width, setWidth] = useState(saved.width);
  const [folded, setFolded] = useState(false);
  const { slot, attach } = useBodySlot();
  const fold = useMemo(() => ({ folded, setFolded }), [folded]);
  const open = chosen && !folded;
  const moving = useSidebarMotion(open, width);
  return (
    <FoldContext.Provider value={fold}>
      <MotionContext.Provider value={moving}>
        <Layout
          open={open}
          // Where it starts: the sidebar keeps its own width as the rail drags it.
          width={saved.width}
          onOpenChange={(open) => {
            // The person's own toggle: theirs from now on, also over a fold.
            setChosen(open);
            setFolded(false);
            SidebarChoice.remember(open);
          }}
          brand={<Brand />}
          sidebar={<div ref={attach} className="contents" />}
        >
          <WidthWatch saved={saved.width} onChange={setWidth} />
          <WidthContext.Provider value={width}>
            <BodySlot.Provider value={slot}>{children}</BodySlot.Provider>
          </WidthContext.Provider>
        </Layout>
      </MotionContext.Provider>
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
  SidebarChoice,
  /** The split view's channel for folding the sidebar without it being remembered. */
  useFold: () => useContext(FoldContext),
  /** Whether the sidebar is sliding open or closed right now. */
  useSidebarMoving: () => useContext(MotionContext),
  /** The sidebar's width open, in pixels, as the rail drags it. */
  useSidebarWidth: () => useContext(WidthContext),
} as const;
