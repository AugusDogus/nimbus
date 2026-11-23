import { readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * The built client's files, read into memory at startup with the brotli and gzip variants the
 * build wrote beside them. Hashed files under `assets/` are cached forever; the rest, such as
 * icons and the web manifest, are revalidated with their ETag.
 */
type Encoding = "br" | "gzip" | "identity";
type Variant = { body: Uint8Array<ArrayBuffer>; etag: string };
export type StaticFile = {
  type: string;
  immutable: boolean;
  variants: Partial<Record<Encoding, Variant>> & { identity: Variant };
};
export type StaticFiles = Map<string, StaticFile>;

const precompressed: Record<string, Exclude<Encoding, "identity">> = {
  ".br": "br",
  ".gz": "gzip",
};

const types: Record<string, string> = {
  ".webmanifest": "application/manifest+json",
};

const etag = (body: Uint8Array, encoding: Encoding) =>
  `"${Bun.hash(body).toString(36)}${encoding === "identity" ? "" : `-${encoding}`}"`;

async function files(root: string, directory = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, directory), {
    withFileTypes: true,
  });
  const nested = await Promise.all(
    entries.map((entry) => {
      const relative = path.posix.join(directory, entry.name);
      return entry.isDirectory()
        ? files(root, relative)
        : Promise.resolve(entry.isFile() ? [relative] : []);
    }),
  );
  return nested.flat();
}

/** Which encodings the client accepts, from `Accept-Encoding`, honoring `q=0`. */
export function accepted(header: string | null) {
  const weights = new Map<string, number>();
  for (const part of (header ?? "").split(",")) {
    const [name = "", ...parameters] = part.trim().toLowerCase().split(";");
    const q = parameters
      .map((parameter) => parameter.trim())
      .find((parameter) => parameter.startsWith("q="));
    const weight = q ? Number(q.slice(2)) : 1;
    if (name) weights.set(name, Number.isNaN(weight) ? 0 : weight);
  }
  const allows = (name: string) =>
    (weights.get(name) ?? weights.get("*") ?? 0) > 0;
  return { br: allows("br"), gzip: allows("gzip") };
}

function matches(header: string | null, tag: string) {
  if (!header) return false;
  return header.split(",").some((entry) => {
    const value = entry.trim();
    return value === "*" || value.replace(/^W\//, "") === tag;
  });
}

/** Written by the build: every file it put in the output directory. */
export const builtFilesList = ".vite/files.json";

async function builtFiles(root: string) {
  const file = path.join(root, builtFilesList);
  const parsed: unknown = await Bun.file(file)
    .json()
    .catch(() => null);
  if (
    !Array.isArray(parsed) ||
    !parsed.every((name) => typeof name === "string")
  )
    throw new Error(
      `The built client at ${root} has no valid ${builtFilesList}, which lists the files Nimbus may serve. Run \`bun run build\`, then start the server again. Nothing has been changed.`,
    );
  return new Set(parsed);
}

const manifestEntry = z.object({
  file: z.string(),
  css: z.array(z.string()).optional(),
  assets: z.array(z.string()).optional(),
});

/** The served paths of what a Vite manifest names as hashed output under `assets/`. */
function hashedOutput(manifest: unknown) {
  const parsed = z.record(z.string(), manifestEntry).safeParse(manifest);
  if (!parsed.success)
    throw new Error(
      "Its .vite/manifest.json is missing or not a Vite manifest.",
    );
  const output = new Set<string>();
  for (const entry of Object.values(parsed.data))
    for (const file of [
      entry.file,
      ...(entry.css ?? []),
      ...(entry.assets ?? []),
    ])
      if (file.startsWith("assets/")) output.add(`/${file}`);
  return output;
}

export const StaticFiles = {
  /**
   * Reads the files under `root` that the build listed, except `exclude`. Anything else placed
   * there, such as source maps or configuration copied in by a deployment, is never served.
   */
  async load(root: string, exclude: string[]): Promise<StaticFiles> {
    const listed = await builtFiles(root);
    const all = new Set((await files(root)).filter((name) => listed.has(name)));
    const loaded: StaticFiles = new Map();
    for (const name of all) {
      const extension = path.extname(name);
      if (precompressed[extension] && all.has(name.slice(0, -extension.length)))
        continue;
      if (exclude.includes(name)) continue;
      const file = Bun.file(path.join(root, name));
      const body = new Uint8Array(await file.arrayBuffer());
      const variants: StaticFile["variants"] = {
        identity: { body, etag: etag(body, "identity") },
      };
      for (const [suffix, encoding] of Object.entries(precompressed))
        if (all.has(name + suffix)) {
          const encoded = new Uint8Array(
            await Bun.file(path.join(root, name + suffix)).arrayBuffer(),
          );
          variants[encoding] = { body: encoded, etag: etag(encoded, encoding) };
        }
      loaded.set(`/${name}`, {
        type: types[extension] ?? file.type,
        immutable: name.startsWith("assets/"),
        variants,
      });
    }
    return loaded;
  },

  /**
   * `files` with the hashed output of the earlier builds at `earlier` that it lacks, so a page
   * opened before an update still loads its lazy chunks from the new server. Only what each
   * build's Vite manifest names as output (entries, chunks, their styles and assets), which is
   * content-addressed, so an earlier file never stands in for a current one and nothing else in
   * an earlier build is served forever. A build whose manifest cannot be read is skipped, with
   * the reason.
   */
  async withEarlierAssets(
    files: StaticFiles,
    earlier: readonly string[],
  ): Promise<{
    files: StaticFiles;
    skipped: { root: string; reason: string }[];
  }> {
    const merged: StaticFiles = new Map(files);
    const skipped: { root: string; reason: string }[] = [];
    for (const root of earlier) {
      let loaded: StaticFiles;
      let output: Set<string>;
      try {
        output = hashedOutput(
          await Bun.file(path.join(root, ".vite/manifest.json")).json(),
        );
        loaded = await StaticFiles.load(root, []);
      } catch (error) {
        skipped.push({
          root,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      for (const [name, file] of loaded)
        if (output.has(name) && !merged.has(name)) merged.set(name, file);
    }
    return { files: merged, skipped };
  },

  /** The response for `file`: the smallest accepted encoding, or 304 when the client has it. */
  respond(file: StaticFile, request: Request): Response {
    const { br, gzip } = accepted(request.headers.get("accept-encoding"));
    const [encoding, variant] =
      br && file.variants.br
        ? (["br", file.variants.br] as const)
        : gzip && file.variants.gzip
          ? (["gzip", file.variants.gzip] as const)
          : (["identity", file.variants.identity] as const);
    const headers = new Headers({
      "Content-Type": file.type,
      "Cache-Control": file.immutable
        ? "public, max-age=31536000, immutable"
        : "no-cache",
      ETag: variant.etag,
      Vary: "Accept-Encoding",
    });
    if (encoding !== "identity") headers.set("Content-Encoding", encoding);
    if (matches(request.headers.get("if-none-match"), variant.etag))
      return new Response(null, { status: 304, headers });
    headers.set("Content-Length", String(variant.body.byteLength));
    // Bun.serve answers HEAD with these headers and no body.
    return new Response(variant.body, { headers });
  },
} as const;
