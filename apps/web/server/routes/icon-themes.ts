import path from "node:path";
import { auth } from "@/lib/auth";
import { accepted } from "@/server/static-files";
import { IconThemeFiles } from "@/server/icon-themes/icon-theme-files";
import { IconThemeLibrary } from "@/server/icon-themes/icon-theme-library";

/**
 * A file of an icon theme the signed-in account can use: its manifest, an icon or its licence.
 * Names carry content hashes, so responses are immutable in the browser's private cache. Theme
 * files are untrusted: they are served with a strict type, `nosniff` and a sandboxing policy, so
 * opening one directly runs nothing, and the app shows icons only with `<img>`.
 */
const headers = (name: string) => ({
  "Content-Type": IconThemeFiles.contentType(name),
  "Cache-Control": "private, max-age=31536000, immutable",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
});

const notFound = () =>
  new Response("This icon theme file does not exist.", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, no-store",
    },
  });

export async function GET(
  request: Request,
  context: { params: Promise<{ theme: string; file: string }> },
) {
  const { theme, file } = await context.params;
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session)
    return new Response("Sign in to Nimbus to load icon themes.", {
      status: 401,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "private, no-store",
      },
    });
  if (!IconThemeFiles.served(file)) return notFound();
  const directory = await IconThemeLibrary.directory(session.user.id, theme);
  if (directory === null) return notFound();
  const absolute = path.join(directory, file);
  if (file.endsWith(".json")) {
    const encodings = accepted(request.headers.get("accept-encoding"));
    for (const [encoding, suffix] of [
      ["br", ".br"],
      ["gzip", ".gz"],
    ] as const) {
      if (!encodings[encoding]) continue;
      const compressed = Bun.file(`${absolute}${suffix}`);
      if (await compressed.exists())
        return new Response(compressed, {
          headers: {
            ...headers(file),
            "Content-Encoding": encoding,
            Vary: "Accept-Encoding",
          },
        });
    }
  }
  const body = Bun.file(absolute);
  if (!(await body.exists())) return notFound();
  return new Response(body, {
    headers: {
      ...headers(file),
      ...(file.endsWith(".json") ? { Vary: "Accept-Encoding" } : {}),
    },
  });
}
