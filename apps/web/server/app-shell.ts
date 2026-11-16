import { access, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";
import { Bootstrap, bootstrapElementId } from "@/client/bootstrap";
import { htmlNonce } from "@/client/html-nonce";
import { RoutePreloads, type PageRoute } from "./route-preloads";
import { StaticFiles } from "./static-files";

/**
 * Serves the browser app: the HTML page for every app address, with a fresh script nonce, and
 * the built client files. In development the page and modules come from the Vite dev server,
 * so edits reload instantly; the server still sets every header itself.
 */
/**
 * What a page carries: its first data, the skeleton it shows until the app renders, and the
 * requests the app will make first, which the browser can start at once.
 */
export type PageContent = {
  data: Bootstrap;
  skeleton: string;
  requests: readonly string[];
};

export type AppShell = {
  /** The page an address names, or null when no route matches it. */
  route(pathname: string): PageRoute | null;
  /** The page HTML for `pathname` with `nonce` in every script tag. */
  html(nonce: string, pathname: string, page: PageContent): Promise<string>;
  /** The `<link rel="stylesheet">` tags of the app, for pages the server renders itself. */
  stylesheets(nonce: string): Promise<string>;
  /** A client file such as a script or icon, or null when there is none at that path. */
  file(request: Request, pathname: string): Promise<Response | null>;
};

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

const fill = (template: string, nonce: string) =>
  template.replaceAll(htmlNonce, nonce);

/** The page's own data, ahead of the app entry that reads it. */
const bootstrapTag = (nonce: string, data: Bootstrap) =>
  Object.keys(data).length === 0
    ? ""
    : `<script type="application/json" id="${bootstrapElementId}" nonce="${nonce}">${Bootstrap.serialize(data)}</script>`;

const root = '<div id="root"></div>';

/** Places the skeleton inside the app's root element, which the app later replaces. */
function withSkeleton(html: string, skeleton: string) {
  if (!html.includes(root))
    throw new Error(
      "The page has no empty #root element, so the app cannot start. Check index.html, then rebuild Nimbus.",
    );
  return html.replace(root, `<div id="root">${skeleton}</div>`);
}

const stylesheetTags = (html: string) =>
  html.match(/<link rel="stylesheet"[^>]*>/g)?.join("") ?? "";

async function production(): Promise<AppShell> {
  const index = `${dist}index.html`;
  try {
    await access(index);
  } catch {
    throw new Error(
      `Nimbus has no built client at ${dist}. Run \`bun run build\`, then start the server again. Nothing has been changed.`,
    );
  }
  const template = await Bun.file(index).text();
  const manifest: unknown = await Bun.file(`${dist}.vite/manifest.json`).json();
  const preloads = RoutePreloads.fromManifest(manifest);
  const files = await StaticFiles.load(dist, [
    "index.html",
    ".vite/manifest.json",
  ]);
  const styles = stylesheetTags(template);
  return {
    route: (pathname) => preloads.match(pathname),
    html: async (nonce, pathname, page) =>
      withSkeleton(
        fill(template, nonce).replace(
          "</head>",
          `${bootstrapTag(nonce, page.data)}${preloads.links(pathname, page.requests)}</head>`,
        ),
        page.skeleton,
      ),
    stylesheets: async (nonce) => fill(styles, nonce),
    file: async (request, pathname) => {
      const file = files.get(pathname);
      if (file) return StaticFiles.respond(file, request);
      // A missing hashed file is an old or wrong reference; never answer it with a page.
      return pathname.startsWith("/assets/")
        ? new Response("Not found", {
            status: 404,
            headers: { "Cache-Control": "no-store" },
          })
        : null;
    },
  };
}

async function development(vite: string): Promise<AppShell> {
  const routesDirectory = fileURLToPath(new URL("../routes/", import.meta.url));
  const routes = RoutePreloads.fromRouteFiles(
    (await readdir(routesDirectory, { recursive: true })).filter(
      (file) => file.endsWith(".tsx") && !file.endsWith("__root.tsx"),
    ),
  );
  const page = async () => {
    const response = await fetch(`${vite}/`, {
      headers: { Accept: "text/html" },
    });
    if (!response.ok)
      throw new Error(
        `The Vite dev server at ${vite} answered ${response.status} for the page. Check its output in this terminal.`,
      );
    return response.text();
  };
  return {
    route: (pathname) => routes.match(pathname),
    html: async (nonce, _pathname, content) =>
      withSkeleton(
        fill(await page(), nonce).replace(
          "</head>",
          `${bootstrapTag(nonce, content.data)}</head>`,
        ),
        content.skeleton,
      ),
    // Vite serves each stylesheet as a module; `?direct` asks for plain CSS.
    stylesheets: async (nonce) =>
      ["/app/globals.css", "/app/fonts.css"]
        .map(
          (href) =>
            `<link rel="stylesheet" href="${href}?direct" nonce="${nonce}">`,
        )
        .join(""),
    file: async (request, pathname) => {
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      headers.delete("host");
      return fetch(`${vite}${pathname}${url.search}`, {
        method: request.method,
        headers,
        redirect: "manual",
        decompress: false,
      });
    },
  };
}

export const AppShell = {
  /** The shell for this process: the built client, or Vite at `NIMBUS_VITE_ORIGIN` in development. */
  async start(mode: { development: boolean }): Promise<AppShell> {
    if (!mode.development) return production();
    const vite = process.env.NIMBUS_VITE_ORIGIN;
    if (!vite)
      throw new Error(
        "NIMBUS_VITE_ORIGIN is not set, so development pages have no Vite dev server to load from. Start Nimbus with `bun dev`, which starts both.",
      );
    return development(vite);
  },

  /**
   * Whether a GET request asks for a page rather than a file. Browsers mark navigations with
   * `Sec-Fetch-Dest: document`; tools that send no such header get the page too.
   */
  wantsPage(request: Request) {
    const destination = request.headers.get("sec-fetch-dest");
    return (
      destination === null ||
      destination === "document" ||
      destination === "iframe"
    );
  },

  /** A compressed HTML response; pages are small and differ per response, so this is cheap. */
  htmlResponse(request: Request, html: string, headers: Headers): Response {
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("Cache-Control", "no-store");
    headers.set("Vary", "Accept-Encoding");
    const accepts = request.headers.get("accept-encoding") ?? "";
    const body = new TextEncoder().encode(html);
    if (/\bbr\b/.test(accepts)) {
      headers.set("Content-Encoding", "br");
      return new Response(
        brotliCompressSync(body, {
          params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
        }),
        { headers },
      );
    }
    if (/\bgzip\b/.test(accepts)) {
      headers.set("Content-Encoding", "gzip");
      return new Response(Bun.gzipSync(body, { level: 6 }), { headers });
    }
    return new Response(body, { headers });
  },
} as const;
