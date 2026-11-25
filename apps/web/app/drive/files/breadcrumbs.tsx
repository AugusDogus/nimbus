import { HardDrive } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";

import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  DropdownContent,
  DropdownMenu,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import { MenuItem } from "@/components/ui/menu-item";
import { menuRowLink } from "@/components/menu-row-link";
import { Device } from "@/lib/device";
import { cn } from "@/lib/utils";
import type { BreadcrumbTrail, Crumb } from "./breadcrumb-trail";
import type { DropTarget } from "./drop-target";
import { FolderLink } from "./folder-link";

/** Hovering the collapsed folders this long while dragging opens them, to drop on one. */
const springMs = 600;

/**
 * The trail's width, in pixels, from which it names the root instead of showing its icon, and
 * from which it shows the parent folder too: as wide as at 1024 px beside the open sidebar, where
 * the parent first fits. A pane of a split view is narrower but still names the root, as the
 * folder it came from did.
 */
const roomFor = { rootName: 240, parent: 400 } as const;

/**
 * What makes the trail's folders take drops: the page's drag, and which of them the account may
 * write to. The current folder is never a target; its items are already there.
 */
export type CrumbDrop = {
  /** Items from the page are being dragged. */
  dragging: boolean;
  /** Files dragged in from the computer can be dropped on the trail's folders. */
  acceptsFiles: boolean;
  writable: (path: string) => boolean;
  targetProps: (target: DropTarget) => {
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDragLeave: (event: DragEvent<HTMLElement>) => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
  };
  dropState: (path: string) => "allowed" | "refused" | null;
};

/** Drop handlers, state and styling for a crumb, or nothing without a drag to take. */
function crumbDrop(drop: CrumbDrop | undefined, crumb: Crumb) {
  if (!drop) return { className: undefined };
  const state = drop.dropState(crumb.path);
  return {
    ...drop.targetProps({
      path: crumb.path,
      writable: drop.writable(crumb.path),
    }),
    "data-drop-target":
      state === "allowed" ? true : state === "refused" ? "refused" : undefined,
    className: cn(
      "rounded-md",
      state === "allowed" &&
        "bg-accent text-foreground outline-2 -outline-offset-2 outline-primary",
      state === "refused" &&
        "cursor-not-allowed outline-2 -outline-offset-2 outline-destructive/50",
    ),
  };
}

/**
 * Wide screens keep the parent visible: `Files > ... > Parent > Current`
 * Narrower ones collapse it too:        `[drive icon] > ... > Current`
 *
 * The root is the account's top folder, so `Files` is the home for an account limited to it.
 * Which one shows follows the trail's own width, whatever the window or the sidebar leaves it.
 * The current folder's name truncates rather than being cut off.
 */
export function FileBreadcrumbs({
  trail,
  drop,
  folded = false,
}: {
  trail: BreadcrumbTrail;
  /** Makes every folder above the current one a drop target. */
  drop?: CrumbDrop;
  /** Keeps the parent folded into "…" at every width, as in a pane of a split view. */
  folded?: boolean;
}) {
  const segmentCrumbs = trail.crumbs;
  const [nav, setNav] = useState<HTMLElement | null>(null);
  const width = Device.useWidth(nav) ?? 0;
  const rootNamed = width >= roomFor.rootName;
  const [menuOpen, setMenuOpen] = useState(false);
  // The collapsed folders open by themselves while something is dragged over them, and close
  // again once that drag ends, wherever it was dropped. The page knows when its own item drag
  // ends; files from the computer end theirs with a drop, or by leaving the window.
  const [sprung, setSprung] = useState<"items" | "files" | null>(null);
  const spring = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (sprung === "items" && !drop?.dragging) {
    setSprung(null);
    setMenuOpen(false);
  }
  useEffect(() => {
    if (sprung !== "files") return;
    const close = () => {
      setSprung(null);
      setMenuOpen(false);
    };
    const left = (event: globalThis.DragEvent) => {
      if (event.relatedTarget === null) close();
    };
    window.addEventListener("drop", close, true);
    window.addEventListener("dragleave", left, true);
    return () => {
      window.removeEventListener("drop", close, true);
      window.removeEventListener("dragleave", left, true);
    };
  }, [sprung]);
  const cancelSpring = () => {
    if (spring.current !== null) clearTimeout(spring.current);
    spring.current = null;
  };
  const isNested = segmentCrumbs.length > 0;

  // The last segment is always rendered as the current (non-link) page.
  const currentPage = isNested ? segmentCrumbs[segmentCrumbs.length - 1] : null;

  // Middle crumbs sit between root and the current page. All but the parent always collapse.
  const middleCrumbs = segmentCrumbs.slice(0, -1);
  const parent = middleCrumbs.at(-1);
  const showParent = width >= roomFor.parent && !folded;
  // With nothing else to collapse, a roomy trail has no ellipsis.
  const ellipsisClassName =
    middleCrumbs.length === 1 && showParent ? "hidden" : undefined;
  const parentClassName = showParent ? undefined : "hidden";

  if (!isNested) {
    return (
      <h1 className="truncate text-balance text-xl font-medium sm:text-2xl">
        {trail.root.label}
      </h1>
    );
  }

  return (
    <Breadcrumb ref={setNav} className="min-w-0">
      {/* On touch screens the root link grows by 14 px on every side to a 44 px touch area, at
          every width: its icon, and the short word "Files", are narrower than that. The list's
          padding gives it room its clipping would otherwise cut; negative margins keep the layout. */}
      <BreadcrumbList className="min-w-0 flex-nowrap overflow-hidden text-sm pointer-coarse:-my-3.5 pointer-coarse:py-3.5 pointer-coarse:-ml-3.5 pointer-coarse:pl-3.5 sm:text-base">
        {/* Root: an icon until the trail has room for its name */}
        <BreadcrumbItem>
          <BreadcrumbLink
            {...crumbDrop(drop, trail.root)}
            className={cn(
              "whitespace-nowrap pointer-coarse:relative pointer-coarse:z-10 pointer-coarse:-my-3.5 pointer-coarse:py-3.5 pointer-coarse:-mx-3.5 pointer-coarse:px-3.5",
              crumbDrop(drop, trail.root).className,
            )}
            render={
              <FolderLink
                path={trail.root.path}
                aria-label={trail.root.label}
              />
            }
          >
            {rootNamed ? (
              <span>{trail.root.label}</span>
            ) : (
              <HardDrive className="size-4" />
            )}
          </BreadcrumbLink>
        </BreadcrumbItem>

        {/* Ellipsis with collapsed segments, then the parent, which collapses too without room */}
        {parent && (
          <>
            <BreadcrumbSeparator className={ellipsisClassName} />
            <BreadcrumbItem className={ellipsisClassName}>
              {/* Their menus are never modal, so a drag can still reach the rest of the page. */}
              <DropdownMenu
                open={menuOpen}
                onOpenChange={(open) => {
                  setMenuOpen(open);
                  if (!open) setSprung(null);
                }}
              >
                <DropdownTrigger
                  onDragEnter={(event) => {
                    const kind = drop?.dragging
                      ? "items"
                      : drop?.acceptsFiles &&
                          event.dataTransfer.types.includes("Files")
                        ? "files"
                        : null;
                    if (kind === null || menuOpen || spring.current !== null)
                      return;
                    spring.current = setTimeout(() => {
                      spring.current = null;
                      setSprung(kind);
                      setMenuOpen(true);
                    }, springMs);
                  }}
                  onDragLeave={cancelSpring}
                  onDrop={cancelSpring}
                  render={
                    <Button
                      size="icon-compact"
                      variant="ghost"
                      className="touch-hit"
                    />
                  }
                >
                  <BreadcrumbEllipsis />
                  <span className="sr-only">Show folders in this path</span>
                </DropdownTrigger>
                <DropdownContent align="start" className="w-auto max-w-80">
                  {middleCrumbs.map((crumb, index) => {
                    const link = menuRowLink(
                      <FolderLink path={crumb.path} />,
                      () => setMenuOpen(false),
                    );
                    return (
                      <MenuItem
                        key={crumb.path}
                        index={index}
                        label={crumb.label}
                        {...crumbDrop(drop, crumb)}
                        {...link}
                        className={cn(
                          crumb === parent && showParent && "hidden",
                          crumbDrop(drop, crumb).className,
                          link.className,
                        )}
                      />
                    );
                  })}
                </DropdownContent>
              </DropdownMenu>
            </BreadcrumbItem>
            <BreadcrumbSeparator className={parentClassName} />
            <BreadcrumbItem className={parentClassName}>
              <BreadcrumbLink
                {...crumbDrop(drop, parent)}
                render={<FolderLink path={parent.path} />}
              >
                {parent.label}
              </BreadcrumbLink>
            </BreadcrumbItem>
          </>
        )}

        {/* Current page */}
        {currentPage && (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem className="min-w-0">
              <BreadcrumbPage className="truncate max-md:max-w-[38vw]">
                {currentPage.label}
              </BreadcrumbPage>
            </BreadcrumbItem>
          </>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
