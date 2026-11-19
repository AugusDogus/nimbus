import { safePath } from "@nimbus/api/file-operations";
import { httpDriveStore, requestAccess } from "@/server/http-files";
import { PdfPagesRoute } from "@/server/pdf-pages-route";
import {
  getPublicShare,
  isShareUnlocked,
  sharedTarget,
} from "@/server/public-share";

/** The signed-in caller's PDF at `?path=`. */
export async function GET(request: Request) {
  return PdfPagesRoute.serve(
    request,
    async (url) => ({
      access: await requestAccess(request),
      relative: (await safePath(url.searchParams.get("path") ?? "")).relative,
      share: null,
    }),
    httpDriveStore,
  );
}

/** A PDF at `?path=` inside the public link `token`, under its endpoint for its cookies. */
export async function sharePdf(request: Request, token: string) {
  return PdfPagesRoute.serve(
    request,
    async (url) => {
      // A browser continuing a counted view may load pages after the last download is used.
      const { share, access } = await getPublicShare(token, {
        exhausted: "allow",
      });
      if (!isShareUnlocked(share, request))
        return PdfPagesRoute.json(
          401,
          "Unlock this share with its password to view it.",
        );
      const scoped = await sharedTarget(
        share,
        access,
        url.searchParams.get("path") ?? "",
      );
      return { access: scoped.access, relative: scoped.target.relative, share };
    },
    httpDriveStore,
  );
}
