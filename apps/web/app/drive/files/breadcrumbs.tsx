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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { BreadcrumbTrail, Crumb } from "./breadcrumb-trail";
import type { DropTarget } from "./drop-target";
import { FolderLink } from "./folder-link";

/** Hovering the collapsed folders this long while dragging opens them, to drop on one. */
const springMs = 600;

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
 * Pure CSS: the parent shows from the `lg` breakpoint, where the sidebar leaves room for it.
 * The current folder's name truncates rather than being cut off.
 */
export function FileBreadcrumbs({
  trail,
  drop,
}: {
  trail: BreadcrumbTrail;
  /** Makes every folder above the current one a drop target. */
  drop?: CrumbDrop;
}) {
  const segmentCrumbs = trail.crumbs;
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
  // With nothing else to collapse, desktop has no ellipsis.
  const ellipsisClassName = middleCrumbs.length === 1 ? "lg:hidden" : undefined;

  if (!isNested) {
    return (
      <h1 className="truncate text-balance text-xl font-medium sm:text-2xl">
        {trail.root.label}
      </h1>
    );
  }

  return (
    <Breadcrumb className="min-w-0">
      {/* On touch screens the root link grows by 14 px on every side to a 44 px touch area, at
          every width: its icon, and the short word "Files", are narrower than that. The list's
          padding gives it room its clipping would otherwise cut; negative margins keep the layout. */}
      <BreadcrumbList className="min-w-0 flex-nowrap overflow-hidden text-sm pointer-coarse:-my-3.5 pointer-coarse:py-3.5 pointer-coarse:-ml-3.5 pointer-coarse:pl-3.5 sm:text-base">
        {/* Root: an icon until 1024 px, where the sidebar leaves room for its name */}
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
            <HardDrive className="size-4 lg:hidden" />
            <span className="max-lg:hidden">{trail.root.label}</span>
          </BreadcrumbLink>
        </BreadcrumbItem>

        {/* Ellipsis with collapsed segments, then the parent, which collapses too on mobile */}
        {parent && (
          <>
            <BreadcrumbSeparator className={ellipsisClassName} />
            <BreadcrumbItem className={ellipsisClassName}>
              {/* Not modal, so a drag can still reach the rest of the page while it is open. */}
              <DropdownMenu
                open={menuOpen}
                onOpenChange={(open) => {
                  setMenuOpen(open);
                  if (!open) setSprung(null);
                }}
                modal={false}
              >
                <DropdownMenuTrigger
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
                      size="icon-sm"
                      variant="ghost"
                      className="touch-hit"
                    />
                  }
                >
                  <BreadcrumbEllipsis />
                  <span className="sr-only">Show folders in this path</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuGroup>
                    {middleCrumbs.map((crumb) => (
                      <DropdownMenuItem
                        key={crumb.path}
                        {...crumbDrop(drop, crumb)}
                        className={cn(
                          crumb === parent && "lg:hidden",
                          crumbDrop(drop, crumb).className,
                        )}
                        render={<FolderLink path={crumb.path} />}
                      >
                        {crumb.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="max-lg:hidden" />
            <BreadcrumbItem className="max-lg:hidden">
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
