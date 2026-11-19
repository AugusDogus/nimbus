import { access, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";
import { Bootstrap, bootstrapElementId } from "@/client/bootstrap";
import { htmlNonce } from "@/client/html-nonce";
import { RoutePreloads, type PageRoute } from "./route-preloads";
import { accepted, StaticFiles } from "./static-files";
import { HtmlText } from "./html-text";

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

/** Pages with an entry and template of their own, named by their HTML file. */
export type PublicPageName = "share" | "file-request" | "auth";
const publicPages: readonly PublicPageName[] = [
  "share",
  "file-request",
  "auth",
];

export type AppShell = {
  /** The page an address names, or null when no route matches it. */
  route(pathname: string): PageRoute | null;
  /** The page HTML for `pathname` with `nonce` in every script tag. */
  html(nonce: string, pathname: string, page: PageContent): Promise<string>;
  /**
   * A public page from its own entry, with `markup` the server rendered in `#root` and `head`
   * added to the head, such as the data the page hydrates with. `title`, when given, replaces
   * the template's title.
   */
  publicHtml(
    name: PublicPageName,
    nonce: string,
    head: string,
    markup: string,
    title: string | null,
  ): Promise<string>;
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

/**
 * A template with `nonce` filled in, `title` as its title when given, `head` before the end of
 * its head and `content` inside its root element. Replacements use callbacks, so `$` in names
 * and data stays literal.
 */
function compose(
  template: string,
  nonce: string,
  head: string,
  content: string,
  title: string | null = null,
) {
  if (!template.includes(root))
    throw new Error(
      "The page template has no empty #root element, so the app cannot start. Check index.html, share.html, file-request.html and auth.html, then rebuild Nimbus.",
    );
  return fill(template, nonce)
    .replace(/<title>[^<]*<\/title>/, (tag) =>
      title === null ? tag : `<title>${HtmlText.escape(title)}</title>`,
    )
    .replace("</head>", () => `${head}</head>`)
    .replace(root, () => `<div id="root">${content}</div>`);
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
  const publicTemplates = new Map(
    await Promise.all(
      publicPages.map(
        async (name) =>
          [name, await Bun.file(`${dist}${name}.html`).text()] as const,
      ),
    ),
  );
  const manifest: unknown = await Bun.file(`${dist}.vite/manifest.json`).json();
  const preloads = RoutePreloads.fromManifest(manifest);
  const files = await StaticFiles.load(dist, [
    "index.html",
    ...publicPages.map((name) => `${name}.html`),
    ".vite/manifest.json",
  ]);
  const styles = stylesheetTags(template);
  return {
    route: (pathname) => preloads.match(pathname),
    html: async (nonce, pathname, page) =>
      compose(
        template,
        nonce,
        `${bootstrapTag(nonce, page.data)}${preloads.links(pathname, page.requests)}`,
        page.skeleton,
      ),
    publicHtml: async (name, nonce, head, markup, title) =>
      compose(publicTemplates.get(name) ?? "", nonce, head, markup, title),
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
  const page = async (file = "") => {
    const response = await fetch(`${vite}/${file}`, {
      headers: { Accept: "text/html" },
    });
    if (!response.ok)
      throw new Error(
        `The Vite dev server at ${vite} answered ${response.status} for the page. Check its output in this terminal.`,
      );
    return response.text();
  };
  // Vite serves each stylesheet as a module; `?direct` asks for plain CSS.
  const stylesheets = (nonce: string) =>
    ["/app/globals.css", "/app/fonts.css"]
      .map(
        (href) =>
          `<link rel="stylesheet" href="${href}?direct" nonce="${nonce}">`,
      )
      .join("");
  return {
    route: (pathname) => routes.match(pathname),
    html: async (nonce, _pathname, content) =>
      compose(
        await page(),
        nonce,
        bootstrapTag(nonce, content.data),
        content.skeleton,
      ),
    // Pages the server renders link the styles their markup needs, which Vite would otherwise
    // add only once their code runs.
    publicHtml: async (name, nonce, head, markup, title) =>
      compose(
        await page(`${name}.html`),
        nonce,
        `${stylesheets(nonce)}${head}`,
        markup,
        title,
      ),
    stylesheets: async (nonce) => stylesheets(nonce),
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
    const accepts = accepted(request.headers.get("accept-encoding"));
    const body = new TextEncoder().encode(html);
    if (accepts.br) {
      headers.set("Content-Encoding", "br");
      return new Response(
        brotliCompressSync(body, {
          params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
        }),
        { headers },
      );
    }
    if (accepts.gzip) {
      headers.set("Content-Encoding", "gzip");
      return new Response(Bun.gzipSync(body, { level: 6 }), { headers });
    }
    return new Response(body, { headers });
  },
} as const;
