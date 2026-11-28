import path from "node:path";
import { gzipSync } from "node:zlib";
import { FileListing } from "@nimbus/api/file-listing";
import { FileIconResolver } from "@/lib/file-icon-resolver";
import { fileListInput } from "@/lib/file-list-request";
import { maxFolderIcons, type FolderIconsBody } from "@/lib/folder-icons";
import { IconManifest } from "@/lib/icon-manifest";
import { httpError } from "@/server/http-files";
import { IconThemeFiles } from "@/server/icon-themes/icon-theme-files";
import { IconThemeLibrary } from "@/server/icon-themes/icon-theme-library";
import { PageBootstrap } from "@/server/page-bootstrap";
import { accepted } from "@/server/static-files";

/**
 * The icons a folder's entries use in the icon set `theme`, in one response: see
 * lib/folder-icons.ts. The folder is listed through the same procedure, with the same access
 * checks, as the page's own listing, so this answers only for folders the caller may list.
 */
const manifests = new Map<string, IconManifest>();

async function manifestIn(directory: string): Promise<IconManifest | null> {
  const name = await IconThemeFiles.manifest(directory);
  if (name === null) return null;
  const file = path.join(directory, name);
  const known = manifests.get(file);
  if (known) return known;
  const parsed = IconManifest.parse(await Bun.file(file).json());
  if (parsed) manifests.set(file, parsed);
  return parsed;
}

const plain = (status: number, message: string) =>
  new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, no-store",
    },
  });

export async function GET(
  request: Request,
  context: { params: Promise<{ theme: string }> },
) {
  const { theme } = await context.params;
  try {
    const { caller, session } = await PageBootstrap.forRequest(request);
    if (!session) return plain(401, "Sign in to Nimbus to load icon themes.");
    const directory = await IconThemeLibrary.directory(session.user.id, theme);
    const manifest = directory ? await manifestIn(directory) : null;
    if (!directory || !manifest)
      return plain(404, "This icon set is not on the server.");
    const folder = new URL(request.url).searchParams.get("path") ?? "";
    const listing = FileListing.decode(
      await caller.files.list(fileListInput(folder, false)),
    );
    if (!listing.ok) return plain(500, listing.error.message);
    // Both schemes: the server does not know which one the page shows.
    const resolvers = [
      FileIconResolver.create(manifest, "dark"),
      ...(manifest.light ? [FileIconResolver.create(manifest, "light")] : []),
    ];
    const names = new Set<string>();
    for (const entry of listing.entries) {
      for (const resolver of resolvers) {
        const index =
          entry.type === "dir"
            ? resolver.folder(entry.name)
            : resolver.file(entry.name);
        const icon = index === null ? undefined : manifest.icons[index];
        if (icon !== undefined) names.add(icon);
      }
      if (names.size >= maxFolderIcons) break;
    }
    const body: FolderIconsBody = { icons: {} };
    for (const name of [...names].slice(0, maxFolderIcons)) {
      const file = Bun.file(path.join(directory, name));
      body.icons[name] = name.endsWith(".svg")
        ? await file.text()
        : Buffer.from(await file.arrayBuffer()).toString("base64");
    }
    const json = JSON.stringify(body);
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      // A folder's icons change with its entries; nothing is kept.
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Cross-Origin-Resource-Policy": "same-origin",
      Vary: "Accept-Encoding",
    };
    return accepted(request.headers.get("accept-encoding")).gzip
      ? new Response(gzipSync(json), {
          headers: { ...headers, "Content-Encoding": "gzip" },
        })
      : new Response(json, { headers });
  } catch (error) {
    return httpError(error);
  }
}
