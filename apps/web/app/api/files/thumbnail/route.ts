import path from "node:path";
import { TRPCError } from "@trpc/server";
import { requireExisting, safePath } from "@nimbus/api/file-operations";
import { FileKind } from "@/lib/file-kind";
import { hasThumbnail } from "@/lib/thumbnail-kind";
import { httpError, requestAccess } from "@/server/http-files";
import {
  getPublicShare,
  isShareUnlocked,
  sharedTarget,
} from "@/server/public-share";
import { thumbnailer } from "@/server/thumbnail-service";
import { thumbnailTag } from "@/server/thumbnails";

// Browsers revalidate every use (`no-cache`), so each request is permission
// checked, while an unchanged file costs a 304 without reading the thumbnail.
const cacheHeaders = (etag: string) => ({
  ETag: etag,
  "Cache-Control": "private, no-cache",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'",
});

async function authorize(request: Request, url: URL) {
  const requested = url.searchParams.get("path") ?? "";
  const token = url.searchParams.get("share");
  if (token === null) {
    const access = await requestAccess(request);
    return { access, relative: (await safePath(requested)).relative };
  }
  const { share, access } = await getPublicShare(token);
  if (!isShareUnlocked(share, request))
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Unlock this share with its password to view thumbnails.",
    });
  const scoped = await sharedTarget(share, access, requested);
  return { access: scoped.access, relative: scoped.target.relative };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const { access, relative } = await authorize(request, url);
    access.require(relative, "read");
    const entry = await requireExisting(relative);
    const name = path.basename(entry.absolute);
    const kind = FileKind.of(name);
    if (!entry.stats.isFile() || !hasThumbnail(name))
      return new Response(null, { status: 415 });
    const source = {
      absolute: entry.absolute,
      relative: entry.relative,
      size: entry.stats.size,
      mtimeMs: entry.stats.mtimeMs,
      kind,
    };
    const etag = `"${thumbnailTag(source)}"`;
    if (request.headers.get("if-none-match") === etag)
      return new Response(null, { status: 304, headers: cacheHeaders(etag) });
    const result = await thumbnailer().get(source, request.signal);
    if (result.type === "unavailable")
      return new Response(null, {
        status: 404,
        headers: { "Cache-Control": "private, no-store" },
      });
    return new Response(new Uint8Array(result.body), {
      headers: { ...cacheHeaders(etag), "Content-Type": "image/webp" },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      return new Response(null, { status: 499 });
    return httpError(error);
  }
}
