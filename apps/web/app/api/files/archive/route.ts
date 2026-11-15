import { TRPCError } from "@trpc/server";
import { createReadStream, type ReadStream } from "node:fs";
import { PassThrough } from "node:stream";
import { ZipFile } from "yazl";
import { httpError, requestAccess, streamBody } from "@/server/http-files";
import { archiveEntries, archiveName, resolveArchiveRoots } from "./archive-entries";

/**
 * Stream one ZIP of several files and folders. A form POST carries the paths, so selections of
 * any size fit. Entries are stored without compression: most large files are already compressed,
 * and STORE keeps throughput at disk speed. yazl writes ZIP64 records when sizes or counts need them.
 */
export async function POST(request: Request) {
  try {
    // Session cookies are SameSite=Lax, which already blocks cross-site POSTs. Refuse them explicitly too.
    if (request.headers.get("sec-fetch-site") === "cross-site")
      throw new TRPCError({ code: "FORBIDDEN", message: "Start downloads from Nimbus itself." });
    const form = await request.formData();
    const paths = form.getAll("path").filter((value): value is string => typeof value === "string");
    const access = await requestAccess(request);
    const roots = await resolveArchiveRoots(paths, access);

    const zip = new ZipFile();
    // yazl's stream is a Node PassThrough; the declared type is the wider readable interface.
    const output = zip.outputStream instanceof PassThrough ? zip.outputStream : null;
    if (!output) throw new Error("yazl did not provide a Node PassThrough output stream.");
    let stopped = false;
    let active: ReadStream | null = null;
    // Client disconnects and cancelled downloads close the output. Stop walking and reading then.
    output.once("close", () => {
      stopped = true;
      active?.destroy();
    });
    request.signal.addEventListener("abort", () => output.destroy(), { once: true });

    void (async () => {
      for await (const entry of archiveEntries(roots, access)) {
        if (stopped) return;
        if (entry.type === "dir") {
          zip.addEmptyDirectory(entry.name, { mtime: entry.mtime });
          continue;
        }
        zip.addReadStreamLazy(entry.name, { size: entry.size, mtime: entry.mtime, compress: false }, (callback) => {
          const stream = createReadStream(entry.absolute);
          active = stream;
          stream.once("close", () => {
            if (active === stream) active = null;
          });
          callback(null, stream);
        });
      }
      zip.end();
    })().catch((error: unknown) => {
      console.error(`ZIP download of ${roots.length} items failed while reading the drive.`, error);
      output.destroy(error instanceof Error ? error : new Error("ZIP generation failed."));
    });

    return new Response(streamBody(output), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(archiveName(roots))}`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return httpError(error);
  }
}
