/**
 * Names the server can make thumbnails for: raster images, PDFs and videos.
 * Kept apart from FileKind so the file grid does not ship the full type table.
 */
const THUMBNAIL_EXTENSIONS = new Set([
  "png",
  "apng",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "tif",
  "tiff",
  "pdf",
  "mp4",
  "m4v",
  "mov",
  "webm",
  "mkv",
  "ogv",
]);

/** The square thumbnails fit inside, in pixels. They are never larger than their image. */
export const THUMBNAIL_SIZE = 256;

export const hasThumbnail = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 && THUMBNAIL_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
};

export const thumbnailExtensions = () => [...THUMBNAIL_EXTENSIONS];
