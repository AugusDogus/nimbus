import { TRPCError } from "@trpc/server";
import {
  archiveEntries,
  archiveName,
  resolveArchiveRoots,
} from "@/server/routes/archive-entries";
import { httpError, requestAccess } from "@/server/http-files";
import { RequestBody } from "@/server/request-body";
import { zipStream } from "@/server/zip-stream";

// About 50,000 selected paths of typical length.
const archiveFormBytes = 16 * 1024 * 1024;

/** Stream one ZIP of several files and folders. A form POST carries the paths, so selections of any size fit. */
export async function POST(request: Request) {
  try {
    // Session cookies are SameSite=Lax, which already blocks cross-site POSTs. Refuse them explicitly too.
    if (request.headers.get("sec-fetch-site") === "cross-site")
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Start downloads from Nimbus itself.",
      });
    const access = await requestAccess(request);
    const limited = await RequestBody.buffered(request, archiveFormBytes);
    if (limited.kind === "too_large") return limited.response;
    const form = await limited.request.formData();
    const paths = form
      .getAll("path")
      .filter((value): value is string => typeof value === "string");
    const roots = await resolveArchiveRoots(paths, access);
    return new Response(
      zipStream(
        archiveEntries(roots, access),
        request.signal,
        `${roots.length} items`,
      ),
      {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(archiveName(roots))}`,
          "Cache-Control": "private, no-store",
        },
      },
    );
  } catch (error) {
    return httpError(error);
  }
}
