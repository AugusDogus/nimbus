import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import { BreadcrumbTrail } from "../files/breadcrumb-trail";

/** `text` with the server's match ranges marked: sorted, disjoint [start, end) offsets. */
export function Highlighted({
  text,
  ranges,
}: {
  text: string;
  ranges: readonly (readonly [number, number])[];
}) {
  if (!ranges.length) return text;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start < at || end > text.length || start >= end) continue;
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark key={start} className="rounded-xs bg-primary/20 text-inherit">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

/**
 * Where the item at `path` is, as the account's breadcrumb names it: "Files / Projects", the
 * account's top folder (its home, or the drive root) reading as Files. `ranges` are matches the server found in the folder's path from the
 * drive root; each is marked on the crumb it falls in.
 */
export function Location({
  path,
  ranges,
}: {
  path: string;
  ranges: readonly (readonly [number, number])[];
}) {
  const top = useQuery(trpc.access.me.queryOptions()).data?.top ?? "";
  const slash = path.lastIndexOf("/");
  const parts = BreadcrumbTrail.spelled(
    slash < 0 ? "" : path.slice(0, slash),
    top,
  );
  return parts.map((part, index) => {
    const { at } = part;
    const own =
      at === null
        ? []
        : ranges.flatMap(([start, end]) => {
            const from = Math.max(start - at, 0);
            const to = Math.min(end - at, part.label.length);
            return from < to ? [[from, to] as const] : [];
          });
    return (
      <span key={index}>
        {index > 0 && BreadcrumbTrail.separator}
        <Highlighted text={part.label} ranges={own} />
      </span>
    );
  });
}
