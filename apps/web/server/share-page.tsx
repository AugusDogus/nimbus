import { renderToReadableStream } from "react-dom/server";
import { SharePageData, sharePageElementId } from "@/app/share/share-page-data";
import { ShareRoot } from "@/app/share/share-root";
import { publicShareQuery, ShareResult } from "@/app/share/share-result";
import { createQueryClient } from "@/lib/query-client";
import type { AppShell } from "./app-shell";
import * as shareRoute from "./routes/share";
import { SecurityHeaders, type SecurityMode } from "./security-headers";

/** The token in a public share address, `/s/<token>`, decoded once as the router did. */
export function shareToken(pathname: string): string | null {
  const match = /^\/s\/([^/]+)\/?$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/**
 * Renders a public share page on the server, so a visitor sees its files at first paint. The
 * listing comes from the share endpoint itself, called in-process with the visitor's request,
 * so expiry, revocation, passwords, preview-only mode and rate limits apply exactly as they do
 * to the browser's own requests: a locked link renders its password form and nothing of its
 * contents. The browser then hydrates the same component through the share entry.
 */
export async function renderSharePage(
  request: Request,
  token: string,
  shell: AppShell,
  mode: SecurityMode,
): Promise<{ html: string; headers: Headers }> {
  const endpoint = new URL(
    `/api/share/${encodeURIComponent(token)}?path=`,
    request.url,
  );
  const response = await shareRoute.GET(
    new Request(endpoint, { headers: request.headers }),
    { params: Promise.resolve({ token }) },
  );
  const body: unknown = await response.json().catch(() => null);
  const result = ShareResult.fromResponse(response.status, body);
  const queryClient = createQueryClient();
  queryClient.setQueryData(publicShareQuery(token, "").queryKey, result);
  // Waits for lazy parts such as the theme styles, which `renderToString` would leave for the
  // browser to render, logging a recoverable error as it hydrates.
  const stream = await renderToReadableStream(
    <ShareRoot queryClient={queryClient} token={token} />,
  );
  await stream.allReady;
  const markup = await new Response(stream).text();
  const nonce = SecurityHeaders.nonce();
  const data = SharePageData.serialize({ token, result });
  const html = await shell.shareHtml(
    nonce,
    `<script type="application/json" id="${sharePageElementId}" nonce="${nonce}">${data}</script>`,
    markup,
  );
  return { html, headers: new Headers(SecurityHeaders.document(nonce, mode)) };
}
