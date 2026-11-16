"use client";

import { Home } from "lucide-react";
import Link from "next/link";

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
  DropdownMenuLinkItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fileHref } from "./types";

/**
 * Desktop keeps the parent visible: `My Drive > ... > Parent > Current`
 * Mobile collapses it too:          `Home > ... > Current`
 *
 * The difference is pure CSS at the `md` breakpoint, so the server renders the right crumbs for
 * either viewport and nothing changes after hydration.
 */
export function FileBreadcrumbs({ pathSegments }: { pathSegments: string[] }) {
  const isNested = pathSegments.length > 0;

  const segmentCrumbs = pathSegments.map((segment, i) => ({
    label: segment,
    href: fileHref(pathSegments.slice(0, i + 1).join("/")),
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
          <BreadcrumbLink asChild>
            <Link href="/" aria-label="My Drive">
              <Home className="size-4 md:hidden" />
              <span className="max-md:hidden">My Drive</span>
            </Link>
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
                      <DropdownMenuLinkItem
                        render={<Link href={crumb.href} />}
                        key={crumb.href}
                        className={crumb === parent ? "md:hidden" : undefined}
                      >
                        {crumb.label}
                      </DropdownMenuLinkItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="max-md:hidden" />
            <BreadcrumbItem className="max-md:hidden">
              <BreadcrumbLink asChild>
                <Link href={parent.href}>{parent.label}</Link>
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
