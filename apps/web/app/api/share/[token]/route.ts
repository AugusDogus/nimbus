import { entryAt, readDirectory } from "@nimbus/api/file-browser";
import {
  httpDriveStore,
  httpError,
  serveFile,
  serveZip,
} from "@/server/http-files";
import { RateLimiter } from "@/server/rate-limit";
import {
  SharePasswordAttempts,
  getPublicShare,
  isShareUnlocked,
  shareCookie,
  sharedTarget,
} from "@/server/public-share";

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
    if (
      url.searchParams.get("download") === "1" ||
      url.searchParams.get("preview") === "1"
    ) {
      const response =
        entry.type === "dir"
          ? await serveZip(scoped.target.relative, scoped.access)
          : await serveFile(
              request,
              scoped.target.relative,
              scoped.access,
              url.searchParams.get("preview") === "1",
            );
      if (response.ok && url.searchParams.get("download") === "1")
        await httpDriveStore.countDownload(share.id);
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
    if (
      share.passwordHash &&
      !(await Bun.password.verify(body.password, share.passwordHash))
    ) {
      SharePasswordAttempts.fail(share, request);
      return Response.json(
        { error: "That password is incorrect. Try again or ask the owner." },
        { status: 401 },
      );
    }
    return Response.json(
      { unlocked: true },
      {
        headers: {
          "Set-Cookie": shareCookie(share, request),
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    return httpError(error);
  }
}
