import { entryAt, readDirectory } from "@nimbus/api/file-browser";
import { serveFile, serveZip } from "@/server/file-response";
import { httpDriveStore, httpError } from "@/server/http-files";
import { RateLimiter } from "@/server/rate-limit";
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
    const { share, access } = await getPublicShare(token);
    if (!isShareUnlocked(share, request))
      return Response.json(
        { passwordRequired: true },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    const url = new URL(request.url);
    const scoped = await sharedTarget(
      share,
      access,
      url.searchParams.get("path") ?? "",
    );
    const entry = await entryAt(scoped.target.relative);
    const download = url.searchParams.get("download") === "1";
    if (download || url.searchParams.get("preview") === "1") {
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
      if (
        SharePolicy.countsAsTransfer(request.method, response) &&
        !(await httpDriveStore.claimDownload(share.id))
      )
        return refuse(
          response,
          404,
          "This share link has reached its download limit. Ask the owner for a new link.",
        );
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
    const allowed = SharePasswordAttempts.check(token, request);
    if (!allowed.allowed)
      return RateLimiter.response(allowed, "wrong passwords for this link");
    let body: unknown;
    try {
      body = await request.json();
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
    if (!(await Bun.password.verify(body.password, passwordHash))) {
      SharePasswordAttempts.fail(share, request);
      return Response.json(
        { error: "That password is incorrect. Try again or ask the owner." },
        { status: 401 },
      );
    }
    const headers = new Headers({ "Cache-Control": "no-store" });
    for (const cookie of shareCookies({ ...share, passwordHash }))
      headers.append("Set-Cookie", cookie);
    return Response.json({ unlocked: true }, { headers });
  } catch (error) {
    return httpError(error);
  }
}
