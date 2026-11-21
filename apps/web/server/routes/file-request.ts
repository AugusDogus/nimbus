import path from "node:path";
import { FileRequest, reservationLifetimeMs } from "@nimbus/api/file-request";
import { httpDriveStore, httpError } from "@/server/http-files";
import {
  activeFileRequest,
  fileRequestCookies,
  FileRequestPasswordAttempts,
  isFileRequestUnlocked,
  Uploader,
} from "@/server/file-request-access";
import { RateLimiter } from "@/server/rate-limit";
import { RequestBody } from "@/server/request-body";
import { DriveRoot } from "@nimbus/api/drive-root";

type Context = { params: Promise<{ token: string }> };
const noStore = { "Cache-Control": "no-store" };

/** What an uploader may see: the folder's name, the note and the limits. Never its contents. */
export async function GET(request: Request, context: Context) {
  try {
    const { token } = await context.params;
    const { request: fileRequest } = await activeFileRequest({ token });
    const headers = new Headers(noStore);
    for (const cookie of Uploader.issue(request))
      headers.append("Set-Cookie", cookie);
    if (!isFileRequestUnlocked(fileRequest, request))
      return Response.json(
        { passwordRequired: true },
        { status: 401, headers },
      );
    const used = await httpDriveStore.fileRequests.usage(
      fileRequest.id,
      Date.now() - reservationLifetimeMs,
    );
    return Response.json(
      {
        folder: path.posix.basename(fileRequest.path) || DriveRoot.label,
        note: fileRequest.note,
        expiresAt: fileRequest.expiresAt,
        maxFileBytes: FileRequest.maxUploadBytes(fileRequest, used),
        remainingFiles:
          fileRequest.maxFiles === null
            ? null
            : Math.max(0, fileRequest.maxFiles - used.files),
      },
      { headers },
    );
  } catch (error) {
    return httpError(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const { token } = await context.params;
    const { request: fileRequest } = await activeFileRequest({ token });
    const read = await RequestBody.read(request, RequestBody.smallJsonBytes);
    if (read.kind === "too_large")
      return RequestBody.tooLargeResponse(read.maxBytes);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(read.bytes));
    } catch {
      return Response.json(
        { error: "Send the password as JSON." },
        { status: 400 },
      );
    }
    if (
      !body ||
      typeof body !== "object" ||
      !("password" in body) ||
      typeof body.password !== "string" ||
      body.password.length > 128
    )
      return Response.json({ error: "Enter the password." }, { status: 400 });
    const { passwordHash } = fileRequest;
    if (passwordHash === null)
      return Response.json({ unlocked: true }, { headers: noStore });
    const attempt = await FileRequestPasswordAttempts.begin(token, request);
    if (attempt.kind === "refused")
      return RateLimiter.response(
        attempt.decision,
        "wrong passwords for this link",
      );
    if (!(await Bun.password.verify(body.password, passwordHash))) {
      FileRequestPasswordAttempts.failed(fileRequest);
      return Response.json(
        {
          error:
            "That password is incorrect. Try again or ask the person who sent the link.",
        },
        { status: 401 },
      );
    }
    attempt.succeeded();
    const headers = new Headers(noStore);
    for (const cookie of fileRequestCookies({ ...fileRequest, passwordHash }))
      headers.append("Set-Cookie", cookie);
    return Response.json({ unlocked: true }, { headers });
  } catch (error) {
    return httpError(error);
  }
}
