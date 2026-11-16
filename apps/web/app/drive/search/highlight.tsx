import type { ReactNode } from "react";

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

/** "a/b/c.txt" → "a/b"; root items read as My Drive. */
export const parentLabel = (path: string) => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "My Drive" : path.slice(0, slash);
};
