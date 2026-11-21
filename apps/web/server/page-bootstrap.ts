import { createContext } from "@nimbus/api/context";
import { auth } from "@/lib/auth";
import { fileHref } from "@/app/drive/files/types";
import { fileListRequest } from "@/lib/file-list-request";
import { Landing } from "@/lib/landing";
import { parseSignedIn } from "@/lib/session-query";
import type { Bootstrap } from "@/client/bootstrap";
import { preferencesStore } from "./preferences";
import type { PageKind } from "./route-preloads";
import { driveStore } from "./services";
import { signInPath } from "./sign-in-path";
import { createWebCaller } from "./web-router";

/**
 * What the server sends with a page, decided before any app code runs: signed-in pages without
 * a session go straight to sign-in, as the server-rendered pages did; others carry the data
 * their first render needs.
 */
export type PageBootstrap =
  | { kind: "redirect"; location: string }
  | { kind: "page"; data: Bootstrap; requests: string[]; folder: boolean };

const signedInKinds = new Set<PageKind>(["files", "settings", "signed-in"]);

/** The request's tRPC caller and its signed-in account, if any, read once per page. */
async function forRequest(request: Request) {
  const context = await createContext({
    auth,
    headers: request.headers,
    preferences: preferencesStore,
    drive: driveStore,
  });
  return {
    caller: createWebCaller(context),
    session: signedIn(context.session),
  };
}

/** The signed-in account in the shape the app's session query returns. */
const signedIn = (session: unknown): Bootstrap["session"] =>
  parseSignedIn(session) ?? undefined;

/**
 * The folder a file browser address shows, decoded as the router decodes it, or null for file
 * browser pages that are not a folder, such as Recent.
 */
function folderOf(pathname: string): string | null {
  if (pathname === "/") return "";
  if (!pathname.startsWith("/browse/") && pathname !== "/browse") return null;
  try {
    return decodeURIComponent(pathname.slice("/browse".length))
      .split("/")
      .filter(Boolean)
      .join("/");
  } catch {
    return null;
  }
}

export const PageBootstrap = {
  forRequest,

  async load(request: Request, kind: PageKind | null): Promise<PageBootstrap> {
    if (kind === null || !signedInKinds.has(kind))
      return { kind: "page", data: {}, requests: [], folder: false };
    const { caller, session } = await forRequest(request);
    if (!session) {
      const { pathname, search } = new URL(request.url);
      return {
        kind: "redirect",
        location: signInPath(pathname + search),
      };
    }
    if (kind !== "files")
      return { kind: "page", data: { session }, requests: [], folder: false };
    const [prefs, me] = await Promise.all([
      caller.prefs.get(),
      caller.access.me(),
    ]);
    const { pathname, search } = new URL(request.url);
    // Where an account starts is answered here, so the page never shows the wrong folder first.
    if (pathname === Landing.PATH)
      return {
        kind: "redirect",
        location: fileHref(Landing.afterSignIn(me)),
      };
    if (pathname === "/home")
      return { kind: "redirect", location: fileHref(me.home ?? "") };
    const home = pathname === "/" ? Landing.rootRedirect(me) : null;
    if (home !== null)
      return { kind: "redirect", location: fileHref(home) + search };
    const folder = folderOf(pathname);
    return {
      kind: "page",
      data: { session, prefs, me },
      folder: folder !== null,
      requests:
        folder === null
          ? []
          : [
              fileListRequest(
                folder,
                prefs.sortField === "modified" || prefs.sortField === "size",
              ),
            ],
    };
  },
} as const;
