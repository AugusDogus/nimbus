import { HardDrive } from "lucide-react";
import { Link } from "@/components/link";

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
import { FolderLink } from "./folder-link";

/**
 * Wide screens keep the parent visible: `My Drive > ... > Parent > Current`
 * Narrower ones collapse it too:        `[drive icon] > ... > Current`
 *
 * Pure CSS: the parent shows from the `lg` breakpoint, where the sidebar leaves room for it.
 * The current folder's name truncates rather than being cut off.
 */
export function FileBreadcrumbs({ pathSegments }: { pathSegments: string[] }) {
  const isNested = pathSegments.length > 0;

  const segmentCrumbs = pathSegments.map((segment, i) => ({
    label: segment,
    path: pathSegments.slice(0, i + 1).join("/"),
  }));

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
        My Drive
      </h1>
    );
  }

  return (
    <Breadcrumb className="min-w-0">
      {/* On touch screens the list's padding gives the root link room for its 44 px touch area,
          which the list's clipping would otherwise cut; the negative margins keep the layout.
          From 1024 px the link is the words "My Drive", wide enough, so it grows only in height. */}
      <BreadcrumbList className="min-w-0 flex-nowrap overflow-hidden text-sm pointer-coarse:-my-3.5 pointer-coarse:py-3.5 max-lg:pointer-coarse:-ml-3.5 max-lg:pointer-coarse:pl-3.5 sm:text-base">
        {/* Root: an icon until 1024 px, where the sidebar leaves room for its name */}
        <BreadcrumbItem>
          <BreadcrumbLink
            className="whitespace-nowrap pointer-coarse:relative pointer-coarse:z-10 pointer-coarse:-my-3.5 pointer-coarse:py-3.5 max-lg:pointer-coarse:-mx-3.5 max-lg:pointer-coarse:px-3.5"
            render={<Link to="/" aria-label="My Drive" />}
          >
            <HardDrive className="size-4 lg:hidden" />
            <span className="max-lg:hidden">My Drive</span>
          </BreadcrumbLink>
        </BreadcrumbItem>

        {/* Ellipsis with collapsed segments, then the parent, which collapses too on mobile */}
        {parent && (
          <>
            <BreadcrumbSeparator className={ellipsisClassName} />
            <BreadcrumbItem className={ellipsisClassName}>
              <DropdownMenu>
                <DropdownMenuTrigger
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
                        className={crumb === parent ? "lg:hidden" : undefined}
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
              <BreadcrumbLink render={<FolderLink path={parent.path} />}>
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
