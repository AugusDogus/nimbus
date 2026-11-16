import path from "node:path";
import { FileRequest, reservationLifetimeMs } from "@nimbus/api/file-request";
import { httpDriveStore, httpError } from "@/server/http-files";
import {
  activeFileRequest,
  fileRequestCookie,
  FileRequestPasswordAttempts,
  isFileRequestUnlocked,
  Uploader,
} from "@/server/file-request-access";
import { RateLimiter } from "@/server/rate-limit";

type Context = { params: Promise<{ token: string }> };
const noStore = { "Cache-Control": "no-store" };

/** What an uploader may see: the folder's name, the note and the limits. Never its contents. */
export async function GET(request: Request, context: Context) {
  try {
    const { token } = await context.params;
    const { request: fileRequest } = await activeFileRequest({ token });
    const headers = new Headers(noStore);
    const uploader = Uploader.issue(request);
    if (uploader) headers.append("Set-Cookie", uploader);
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
        folder: path.posix.basename(fileRequest.path) || "My Drive",
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
    const attempt = FileRequestPasswordAttempts.check(token, request);
    if (!attempt.allowed)
      return RateLimiter.response(attempt, "wrong passwords for this link");
    let body: unknown;
    try {
      body = await request.json();
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
    if (!(await Bun.password.verify(body.password, passwordHash))) {
      FileRequestPasswordAttempts.fail(fileRequest, request);
      return Response.json(
        {
          error:
            "That password is incorrect. Try again or ask the person who sent the link.",
        },
        { status: 401 },
      );
    }
    return Response.json(
      { unlocked: true },
      {
        headers: {
          ...noStore,
          "Set-Cookie": fileRequestCookie({ ...fileRequest, passwordHash }),
        },
      },
    );
  } catch (error) {
    return httpError(error);
  }
}
