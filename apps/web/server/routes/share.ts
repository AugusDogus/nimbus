import { entryAt, readDirectory } from "@nimbus/api/file-browser";
import { serveFile, serveZip } from "@/server/file-response";
import { httpDriveStore, httpError } from "@/server/http-files";
import { RateLimiter } from "@/server/rate-limit";
import { RequestBody } from "@/server/request-body";
import {
  SharePasswordAttempts,
  getPublicShare,
  isShareUnlocked,
  shareCookies,
  sharedTarget,
} from "@/server/public-share";
import { SharePolicy } from "@/server/share-policy";

const refuse = (response: Response, status: number, error: string) => {
  void response.body?.cancel();
  return Response.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
};

type Context = { params: Promise<{ token: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { token } = await context.params;
    const url = new URL(request.url);
    const download = url.searchParams.get("download") === "1";
    const bytes = download || url.searchParams.get("preview") === "1";
    const { share, access } = await getPublicShare(token, {
      exhausted: bytes ? "allow" : "refuse",
    });
    if (!isShareUnlocked(share, request))
      return Response.json(
        { passwordRequired: true },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    const scoped = await sharedTarget(
      share,
      access,
      url.searchParams.get("path") ?? "",
    );
    const entry = await entryAt(scoped.target.relative);
    if (bytes) {
      if (share.mode === "view" && (download || entry.type === "dir"))
        return Response.json(
          {
            error:
              "This link allows previews only. Ask the owner for a download link.",
          },
          { status: 403, headers: { "Cache-Control": "no-store" } },
        );
      const response =
        entry.type === "dir"
          ? await serveZip(scoped.target.relative, scoped.access)
          : await serveFile(
              request,
              scoped.target.relative,
              scoped.access,
              !download,
            );
      if (!SharePolicy.permitsResponse(share.mode, response))
        return refuse(
          response,
          403,
          "This file cannot be previewed, and this link allows previews only. Ask the owner for a download link.",
        );
      const relative = scoped.target.relative;
      const exhausted = () =>
        refuse(
          response,
          404,
          "This share link has reached its download limit. Ask the owner for a new link.",
        );
      if (SharePolicy.countsAsTransfer(request, response, share, relative)) {
        // Atomic: of two requests for the last download, only one claims it.
        if (!(await httpDriveStore.claimDownload(share.id))) return exhausted();
        if (entry.type === "file")
          SharePolicy.allowContinuation(response, share, relative);
      } else if (
        // Only a range continuing a counted transfer is served once downloads are used up.
        response.status !== 206 &&
        SharePolicy.availability(share, Date.now()).kind === "exhausted"
      )
        return exhausted();
      return response;
    }
    const entries =
      entry.type === "dir"
        ? await readDirectory(entry.path, scoped.access)
        : [];
    const relative = (requested: string) =>
      share.path
        ? requested.slice(share.path.length).replace(/^\//, "")
        : requested;
    return Response.json(
      {
        entry: { ...entry, path: relative(entry.path) },
        entries: entries.map((child) => ({
          ...child,
          path: relative(child.path),
        })),
        expiresAt: share.expiresAt,
        mode: share.mode,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return httpError(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const { token } = await context.params;
    const { share } = await getPublicShare(token);
    const read = await RequestBody.read(request, RequestBody.smallJsonBytes);
    if (read.kind === "too_large")
      return RequestBody.tooLargeResponse(read.maxBytes);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(read.bytes));
    } catch {
      return Response.json(
        { error: "Send the share password as JSON." },
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
      return Response.json(
        { error: "Enter the share password." },
        { status: 400 },
      );
    const { passwordHash } = share;
    if (passwordHash === null)
      return Response.json(
        { unlocked: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    const attempt = await SharePasswordAttempts.begin(token, request);
    if (attempt.kind === "refused")
      return RateLimiter.response(
        attempt.decision,
        "wrong passwords for this link",
      );
    if (!(await Bun.password.verify(body.password, passwordHash))) {
      SharePasswordAttempts.failed(share);
      return Response.json(
        { error: "That password is incorrect. Try again or ask the owner." },
        { status: 401 },
      );
    }
    attempt.succeeded();
    const headers = new Headers({ "Cache-Control": "no-store" });
    for (const cookie of shareCookies({ ...share, passwordHash }))
      headers.append("Set-Cookie", cookie);
    return Response.json({ unlocked: true }, { headers });
  } catch (error) {
    return httpError(error);
  }
}
