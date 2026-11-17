import path from "node:path";
import { TRPCError } from "@trpc/server";
import type { Access } from "@nimbus/api/access";
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

type Authorized = { access: Pick<Access, "require">; relative: string };

/** The signed-in caller's thumbnail of `?path=`. */
export async function GET(request: Request) {
  return thumbnail(request, async (url) => ({
    access: await requestAccess(request),
    relative: (await safePath(url.searchParams.get("path") ?? "")).relative,
  }));
}

/**
 * A thumbnail of `?path=` inside the public link `token`. It is served under the link's own
 * endpoint, where the browser sends the link's unlock cookie.
 */
export async function shareThumbnail(request: Request, token: string) {
  return thumbnail(request, async (url) => {
    const { share, access } = await getPublicShare(token);
    if (!isShareUnlocked(share, request))
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Unlock this share with its password to view thumbnails.",
      });
    const scoped = await sharedTarget(
      share,
      access,
      url.searchParams.get("path") ?? "",
    );
    return { access: scoped.access, relative: scoped.target.relative };
  });
}

async function thumbnail(
  request: Request,
  authorize: (url: URL) => Promise<Authorized>,
) {
  try {
    const { access, relative } = await authorize(new URL(request.url));
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
