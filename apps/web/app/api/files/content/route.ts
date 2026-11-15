import { safePath } from "@nimbus/api/file-operations";
import { saveFileContent } from "@/server/file-content";
import { httpDriveStore, httpError, requestAccess } from "@/server/http-files";

/** Save edited text. Requires `If-Match` with the ETag the editor loaded. */
export async function PUT(request: Request) {
  try {
    const access = await requestAccess(request);
    const target = await safePath(
      new URL(request.url).searchParams.get("path") ?? "",
    );
    const ifMatch = request.headers.get("if-match");
    if (!ifMatch)
      return Response.json(
        {
          error:
            "Saving requires the If-Match header with the file's ETag, so concurrent changes are not overwritten.",
        },
        { status: 428 },
      );
    if (!request.body)
      return Response.json(
        { error: "Send the file contents as the request body." },
        { status: 400 },
      );
    const saved = await saveFileContent({
      store: httpDriveStore,
      access,
      requested: target.relative,
      ifMatch,
      body: request.body,
    });
    return Response.json(saved, {
      headers: { ETag: saved.etag, "Cache-Control": "no-store" },
    });
  } catch (error) {
    return httpError(error);
  }
}
