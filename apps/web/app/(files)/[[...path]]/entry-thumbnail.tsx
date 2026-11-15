"use client";

import Image from "next/image";
import { useState, type ReactNode } from "react";
import { FileKind } from "@/lib/file-kind";

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
  entry.type === "file" && FileKind.hasThumbnail(FileKind.of(entry.name));

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
      className={["flex shrink-0 items-center justify-center", className].filter(Boolean).join(" ")}
    >
      {!hasThumbnail(entry) || failed === src ? (
        fallback
      ) : (
        <Image
          unoptimized
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
