import { TRPCError } from "@trpc/server";
import {
  archiveEntries,
  archiveName,
  resolveArchiveRoots,
} from "@/server/routes/archive-entries";
import { allowedOrigins } from "@/lib/auth";
import { httpError, requestAccess } from "@/server/http-files";
import { RequestBody } from "@/server/request-body";
import { zipStream } from "@/server/zip-stream";

// About 50,000 selected paths of typical length.
const archiveFormBytes = 16 * 1024 * 1024;

/** Stream one ZIP of several files and folders. A form POST carries the paths, so selections of any size fit. */
export async function POST(request: Request) {
  try {
    // A form POST authenticated by cookie: refuse it unless it comes from Nimbus's own pages.
    // SameSite=Lax cookies still reach a POST from a sibling subdomain ("same-site"). Nimbus
    // pages send Origin "null" (no-referrer policy), which any page can also produce, so only
    // fetch metadata proves the origin then. Every current browser sends it.
    const site = request.headers.get("sec-fetch-site");
    const from = request.headers.get("origin");
    if (
      site !== null
        ? site !== "same-origin" && site !== "none"
        : from !== null && !allowedOrigins.has(from)
    )
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
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(archiveName(roots))}`,
          "Cache-Control": "private, no-store",
        },
      },
    );
  } catch (error) {
    return httpError(error);
  }
}
