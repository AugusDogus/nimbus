import { Home } from "lucide-react";
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
 * Desktop keeps the parent visible: `My Drive > ... > Parent > Current`
 * Mobile collapses it too:          `Home > ... > Current`
 *
 * The difference is pure CSS at the `md` breakpoint.
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
  const ellipsisClassName = middleCrumbs.length === 1 ? "md:hidden" : undefined;

  if (!isNested) {
    return (
      <h1 className="truncate text-balance text-xl font-medium sm:text-2xl">
        My Drive
      </h1>
    );
  }

  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="min-w-0 flex-nowrap overflow-hidden text-sm sm:text-base">
        {/* Root: icon on mobile, text on desktop */}
        <BreadcrumbItem>
          <BreadcrumbLink render={<Link to="/" aria-label="My Drive" />}>
            <Home className="size-4 md:hidden" />
            <span className="max-md:hidden">My Drive</span>
          </BreadcrumbLink>
        </BreadcrumbItem>

        {/* Ellipsis with collapsed segments, then the parent, which collapses too on mobile */}
        {parent && (
          <>
            <BreadcrumbSeparator className={ellipsisClassName} />
            <BreadcrumbItem className={ellipsisClassName}>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button size="icon-sm" variant="ghost" />}
                >
                  <BreadcrumbEllipsis />
                  <span className="sr-only">Toggle menu</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuGroup>
                    {middleCrumbs.map((crumb) => (
                      <DropdownMenuItem
                        key={crumb.path}
                        className={crumb === parent ? "md:hidden" : undefined}
                        render={<FolderLink path={crumb.path} />}
                      >
                        {crumb.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="max-md:hidden" />
            <BreadcrumbItem className="max-md:hidden">
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
            <BreadcrumbItem>
              <BreadcrumbPage className="max-md:max-w-[38vw] max-md:truncate">
                {currentPage.label}
              </BreadcrumbPage>
            </BreadcrumbItem>
          </>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
