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
 * image while an unchanged file revalidates with a 304. A public link's
 * thumbnails come from its own endpoint, which receives its unlock cookie.
 */
export function thumbnailSrc(entry: ThumbnailEntry, share?: string) {
  const params = new URLSearchParams({ path: entry.path });
  params.set("v", `${entry.mtime ?? 0}-${entry.size ?? 0}`);
  return share === undefined
    ? `/api/files/thumbnail?${params}`
    : `/api/share/${encodeURIComponent(share)}/thumbnail?${params}`;
}

export const hasThumbnail = (entry: ThumbnailEntry) =>
  entry.type === "file" && nameHasThumbnail(entry.name);

/** A fixed-size box: loading or failing never shifts surrounding layout. */
export function EntryThumbnail({
  entry,
  share,
  fallback,
  className,
  fill = false,
}: {
  entry: ThumbnailEntry;
  share?: string;
  fallback: ReactNode;
  className?: string;
  /** Crops the image to fill the box, as a grid card's picture does; otherwise it fits whole. */
  fill?: boolean;
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
        <img
          src={src}
          width={256}
          height={256}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(src)}
          // An image in server-rendered markup can fail before the page handles errors.
          ref={(image) => {
            if (image?.complete && image.naturalWidth === 0) setFailed(src);
          }}
          className={
            fill ? "size-full object-cover" : "size-full object-contain"
          }
        />
      )}
    </span>
  );
}
