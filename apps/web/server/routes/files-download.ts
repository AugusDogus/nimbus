import { serveFile, serveZip } from "@/server/file-response";
import { httpError, requestAccess } from "@/server/http-files";
import { safePath } from "@nimbus/api/file-operations";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const target = await safePath(url.searchParams.get("path") ?? "");
    const access = await requestAccess(request);
    return url.searchParams.get("zip") === "1"
      ? await serveZip(
          target.relative,
          // The session and permissions again, before each file the archive adds.
          () => requestAccess(request),
          request.method === "HEAD",
        )
      : await serveFile(
          request,
          target.relative,
          access,
          url.searchParams.get("preview") === "1",
        );
  } catch (error) {
    return httpError(error);
  }
}
export const HEAD = GET;
