"use client";

import { Home } from "lucide-react";
import Link from "next/link";
import { Fragment } from "react";

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
import { fileHref } from "./types";
import { useIsMobile } from "@/hooks/use-mobile";

/**
 * Maximum number of middle segments (between root and current page) to keep
 * visible before collapsing the rest into an ellipsis dropdown.
 *
 * Desktop keeps 1 parent visible: `My Drive > ... > Parent > Current`
 * Mobile keeps 0 to save space:   `Home > ... > Current`
 */
const MAX_VISIBLE_MIDDLE_DESKTOP = 1;
const MAX_VISIBLE_MIDDLE_MOBILE = 0;

export function FileBreadcrumbs({ pathSegments }: { pathSegments: string[] }) {
  const isMobile = useIsMobile();
  const isNested = pathSegments.length > 0;
  const maxVisible = isMobile
    ? MAX_VISIBLE_MIDDLE_MOBILE
    : MAX_VISIBLE_MIDDLE_DESKTOP;

  const segmentCrumbs = pathSegments.map((segment, i) => ({
    label: segment,
    href: fileHref(pathSegments.slice(0, i + 1).join("/")),
  }));

  // The last segment is always rendered as the current (non-link) page.
  const currentPage = isNested ? segmentCrumbs[segmentCrumbs.length - 1] : null;

  // Middle crumbs sit between root and the current page.
  const middleCrumbs = segmentCrumbs.slice(0, -1);
  const needsCollapse = middleCrumbs.length > maxVisible;
  const collapsedCrumbs = needsCollapse
    ? middleCrumbs.slice(0, middleCrumbs.length - maxVisible)
    : [];
  const visibleMiddleCrumbs = needsCollapse
    ? middleCrumbs.slice(middleCrumbs.length - maxVisible)
    : middleCrumbs;
  const labelClassName = isMobile ? "max-w-[38vw] truncate" : "";

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
            <Link href="/" className={labelClassName} aria-label="My Drive">
              {isMobile ? <Home className="size-4" /> : "My Drive"}
            </Link>
          </BreadcrumbLink>
        </BreadcrumbItem>

        {/* Ellipsis with collapsed segments */}
        {needsCollapse && (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant="ghost">
                    <BreadcrumbEllipsis />
                    <span className="sr-only">Toggle menu</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuGroup>
                    {collapsedCrumbs.map((crumb) => (
                      <DropdownMenuItem key={crumb.href} asChild>
                        <Link href={crumb.href}>{crumb.label}</Link>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </BreadcrumbItem>
          </>
        )}

        {/* Visible middle segments (links) */}
        {visibleMiddleCrumbs.map((crumb) => (
          <Fragment key={crumb.href}>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href={crumb.href} className={labelClassName}>
                  {crumb.label}
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
          </Fragment>
        ))}

        {/* Current page */}
        {currentPage && (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage className={labelClassName}>
                {currentPage.label}
              </BreadcrumbPage>
            </BreadcrumbItem>
          </>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
