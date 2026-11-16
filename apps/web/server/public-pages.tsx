import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";
import { FileRequestUpload } from "@/app/file-request/file-request-upload";
import {
  fileRequestQuery,
  FileRequestResult,
} from "@/app/file-request/file-request-result";
import { PublicShare } from "@/app/share/public-share";
import { publicShareQuery, ShareResult } from "@/app/share/share-result";
import { PublicRoot, publicPageElementId } from "@/client/public-page";
import { inlineJson } from "@/lib/inline-json";
import { createQueryClient } from "@/lib/query-client";
import type { AppShell, PublicPageName } from "./app-shell";
import * as fileRequestRoute from "./routes/file-request";
import * as shareRoute from "./routes/share";
import { SecurityHeaders, type SecurityMode } from "./security-headers";

/** The token of a public page address, `/<prefix>/<token>`, decoded once as the router did. */
function tokenAt(pathname: string, prefix: string): string | null {
  const match = new RegExp(`^/${prefix}/([^/]+)/?$`).exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** The endpoint's answer to the page's own first request, made in-process with its cookies. */
async function call(
  request: Request,
  path: string,
  handler: (
    request: Request,
    context: { params: Promise<{ token: string }> },
  ) => Promise<Response>,
  token: string,
) {
  const response = await handler(
    new Request(new URL(path, request.url), { headers: request.headers }),
    { params: Promise.resolve({ token }) },
  );
  const body: unknown = await response.json().catch(() => null);
  // Cookies the endpoint sets, such as an uploader's identity, reach the browser with the page.
  return {
    status: response.status,
    body,
    cookies: response.headers.getSetCookie(),
  };
}

/**
 * The public share and upload pages, rendered on the server so a visitor sees them at first
 * paint. Each reads its endpoint in-process with the visitor's request, so expiry, revocation,
 * passwords, limits and rate limits apply exactly as to the browser's own requests: a locked
 * link renders its password form and nothing behind it. The browser hydrates the same
 * components through the page's own entry.
 */
export const PublicPages = {
  async render(
    request: Request,
    pathname: string,
    shell: AppShell,
    mode: SecurityMode,
  ): Promise<{ html: string; headers: Headers } | null> {
    const shareToken = tokenAt(pathname, "s");
    if (shareToken !== null) {
      const answer = await call(
        request,
        `/api/share/${encodeURIComponent(shareToken)}?path=`,
        shareRoute.GET,
        shareToken,
      );
      const result = ShareResult.fromResponse(answer.status, answer.body);
      const queryClient = createQueryClient();
      queryClient.setQueryData(
        publicShareQuery(shareToken, "").queryKey,
        result,
      );
      return page("share", shell, mode, queryClient, answer.cookies, {
        data: { token: shareToken, result },
        content: <PublicShare token={shareToken} />,
      });
    }
    const requestToken = tokenAt(pathname, "r");
    if (requestToken !== null) {
      const answer = await call(
        request,
        `/api/file-request/${encodeURIComponent(requestToken)}`,
        fileRequestRoute.GET,
        requestToken,
      );
      const result = FileRequestResult.fromResponse(answer.status, answer.body);
      const queryClient = createQueryClient();
      queryClient.setQueryData(fileRequestQuery(requestToken).queryKey, result);
      return page("file-request", shell, mode, queryClient, answer.cookies, {
        data: { token: requestToken, result },
        content: <FileRequestUpload token={requestToken} />,
      });
    }
    return null;
  },
} as const;

async function page(
  name: PublicPageName,
  shell: AppShell,
  mode: SecurityMode,
  queryClient: ReturnType<typeof createQueryClient>,
  cookies: string[],
  { data, content }: { data: unknown; content: ReactNode },
) {
  // Waits for lazy parts such as the theme styles, which `renderToString` would leave for the
  // browser, logging a recoverable error as it hydrates.
  const stream = await renderToReadableStream(
    <PublicRoot queryClient={queryClient}>{content}</PublicRoot>,
  );
  await stream.allReady;
  const markup = await new Response(stream).text();
  const nonce = SecurityHeaders.nonce();
  const html = await shell.publicHtml(
    name,
    nonce,
    `<script type="application/json" id="${publicPageElementId}" nonce="${nonce}">${inlineJson(data)}</script>`,
    markup,
  );
  const headers = new Headers(SecurityHeaders.document(nonce, mode));
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return { html, headers };
}
