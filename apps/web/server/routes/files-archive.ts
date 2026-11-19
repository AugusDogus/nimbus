import { TRPCError } from "@trpc/server";
import {
  archiveEntries,
  archiveName,
  resolveArchiveRoots,
} from "@/server/routes/archive-entries";
import { allowedOrigins } from "@/lib/auth";
import { ContentDisposition } from "@/server/content-disposition";
import { httpError, requestAccess } from "@/server/http-files";
import { RequestBody } from "@/server/request-body";
import { RequestOrigin } from "@/server/request-origin";
import { zipStream } from "@/server/zip-stream";

// About 50,000 selected paths of typical length.
const archiveFormBytes = 16 * 1024 * 1024;

/** Stream one ZIP of several files and folders. A form POST carries the paths, so selections of any size fit. */
export async function POST(request: Request) {
  try {
    // A form POST authenticated by cookie: refuse it unless it comes from Nimbus's own pages.
    if (!RequestOrigin.fromNimbus(request, allowedOrigins))
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Start downloads from Nimbus itself, in a current browser. Nothing was downloaded.",
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
          "Content-Disposition": ContentDisposition.header(
            "attachment",
            archiveName(roots),
          ),
          "Cache-Control": "private, no-store",
        },
      },
    );
  } catch (error) {
    return httpError(error);
  }
}
