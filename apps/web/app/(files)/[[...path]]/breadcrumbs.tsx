"use client";

import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { Fragment } from "react";

import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

function decodeSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function FileBreadcrumbs({ pathSegments }: { pathSegments: string[] }) {
  const isNested = pathSegments.length > 0;
  const currentLabel = isNested
    ? decodeSegment(pathSegments[pathSegments.length - 1])
    : "My Drive";
  const parentHref = isNested
    ? pathSegments.length === 1
      ? "/"
      : `/${pathSegments.slice(0, -1).join("/")}`
    : null;

  return (
    <>
      {/* Mobile: back arrow + current folder name */}
      {isNested ? (
        <div className="flex items-center gap-1 md:hidden">
          <Link
            href={parentHref!}
            className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Go back"
          >
            <ChevronLeft className="size-5" />
          </Link>
          <span className="truncate text-sm font-medium">{currentLabel}</span>
        </div>
      ) : (
        /* At root on mobile: show nothing (the sidebar trigger is already there) */
        <div className="md:hidden" />
      )}

      {/* Desktop: full breadcrumb trail */}
      <Breadcrumb className="hidden md:block">
        <BreadcrumbList>
          <BreadcrumbItem>
            {pathSegments.length === 0 ? (
              <BreadcrumbPage>My Drive</BreadcrumbPage>
            ) : (
              <BreadcrumbLink asChild>
                <Link href="/">My Drive</Link>
              </BreadcrumbLink>
            )}
          </BreadcrumbItem>
          {pathSegments.map((segment, index) => {
            const crumbPath = pathSegments.slice(0, index + 1).join("/");
            const isLast = index === pathSegments.length - 1;
            const label = decodeSegment(segment);
            return (
              <Fragment key={crumbPath}>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  {isLast ? (
                    <BreadcrumbPage>{label}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink asChild>
                      <Link href={`/${crumbPath}`}>{label}</Link>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>
    </>
  );
}
