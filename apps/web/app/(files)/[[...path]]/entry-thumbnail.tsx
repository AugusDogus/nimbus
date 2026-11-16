"use client";

import { useState, type ReactNode } from "react";
import { hasThumbnail as nameHasThumbnail } from "@/lib/thumbnail-kind";

type ThumbnailEntry = {
  name: string;
  path: string;
  type: string;
  mtime: number | null;
  size: number | null;
};

/**
 * The version parameter changes with the file, so a live update swaps the
 * image while an unchanged file revalidates with a 304.
 */
export function thumbnailSrc(entry: ThumbnailEntry, share?: string) {
  const params = new URLSearchParams({ path: entry.path });
  if (share !== undefined) params.set("share", share);
  params.set("v", `${entry.mtime ?? 0}-${entry.size ?? 0}`);
  return `/api/files/thumbnail?${params}`;
}

export const hasThumbnail = (entry: ThumbnailEntry) =>
  entry.type === "file" && nameHasThumbnail(entry.name);

/** A fixed-size box: loading or failing never shifts surrounding layout. */
export function EntryThumbnail({
  entry,
  share,
  fallback,
  className,
}: {
  entry: ThumbnailEntry;
  share?: string;
  fallback: ReactNode;
  className?: string;
}) {
  const src = thumbnailSrc(entry, share);
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span
      // Thumbnails mount while scrolling large grids; these classes never conflict, so join them directly.
      className={["flex shrink-0 items-center justify-center", className]
        .filter(Boolean)
        .join(" ")}
    >
      {!hasThumbnail(entry) || failed === src ? (
        fallback
      ) : (
        // Already sized by the server; next/image would only add its runtime.
        // oxlint-disable-next-line nextjs/no-img-element
        <img
          src={src}
          width={256}
          height={256}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(src)}
          className="size-full object-contain"
        />
      )}
    </span>
  );
}
