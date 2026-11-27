import { createHash } from "node:crypto";
import * as z from "zod/mini";

/**
 * The server's own Open VSX client for file icon themes. Browsers never fetch icon themes; the
 * server does, from one registry (Open VSX, or `NIMBUS_OPEN_VSX_URL` for tests and mirrors),
 * following redirects only to that registry and its download host, with every response capped.
 * The client never supplies a URL: it names an extension, and the server looks it up.
 */
export type OpenVsxResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const defaultRegistry = "https://open-vsx.org";
/** Open VSX answers downloads with a redirect to its content host. */
const contentHosts: Record<string, string[]> = {
  "open-vsx.org": ["openvsx.eclipsecontent.org"],
};

function registry(): URL | null {
  try {
    const url = new URL(process.env.NIMBUS_OPEN_VSX_URL || defaultRegistry);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
      return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

const badRegistry =
  "NIMBUS_OPEN_VSX_URL is not an https address, so Nimbus will not contact it for icon themes. Fix or unset it and restart the server.";
const unreachable =
  "Open VSX could not be reached from the Nimbus server. Check the server's internet connection and try again. Your icon sets are unchanged.";

async function request(
  url: URL,
  limit: number,
  signal?: AbortSignal,
): Promise<OpenVsxResult<Uint8Array>> {
  const base = registry();
  if (!base) return { ok: false, error: badRegistry };
  const allowed = new Set([base.host, ...(contentHosts[base.hostname] ?? [])]);
  let current = url;
  try {
    for (let hop = 0; hop < 4; hop++) {
      if (
        !allowed.has(current.host) ||
        (current.protocol !== base.protocol && current.protocol !== "https:") ||
        current.username ||
        current.password
      )
        return {
          ok: false,
          error: `Open VSX sent the download to ${current.host}, which Nimbus does not fetch from. Nothing was installed.`,
        };
      const response = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.any([
          ...(signal ? [signal] : []),
          AbortSignal.timeout(30_000),
        ]),
        headers: { Accept: "application/json, application/octet-stream" },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) break;
        current = new URL(location, current);
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return {
          ok: false,
          error:
            response.status === 404
              ? "Open VSX has no such extension or file. Search again and retry."
              : `Open VSX could not complete the request (HTTP ${response.status}). Try again shortly.`,
        };
      }
      const declared = Number(response.headers.get("content-length"));
      if (declared > limit) {
        await response.body.cancel();
        return { ok: false, error: tooLarge(limit) };
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > limit) return { ok: false, error: tooLarge(limit) };
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { ok: true, value: bytes };
    }
    return {
      ok: false,
      error: "Open VSX redirected too many times. Try again shortly.",
    };
  } catch {
    return { ok: false, error: unreachable };
  }
}

const tooLarge = (limit: number) =>
  `The Open VSX download is larger than ${Math.round(limit / 1024 / 1024)} MB, the most Nimbus accepts for an icon theme. Nothing was installed.`;

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

const identifier = z
  .string()
  .check(z.minLength(1), z.maxLength(100), z.regex(/^[\w.-]+$/));
const versionSchema = z
  .string()
  .check(z.minLength(1), z.maxLength(64), z.regex(/^[\w.+-]+$/));
const searchSchema = z.object({
  extensions: z.array(
    z.object({
      namespace: identifier,
      name: identifier,
      version: versionSchema,
      displayName: z.optional(z.string().check(z.maxLength(200))),
      description: z.optional(z.string().check(z.maxLength(2000))),
    }),
  ),
});
const manifestSchema = z.object({
  contributes: z.optional(
    z.object({ iconThemes: z.optional(z.array(z.unknown())) }),
  ),
});
const detailSchema = z.object({
  namespace: identifier,
  name: identifier,
  version: versionSchema,
  displayName: z.optional(z.string().check(z.maxLength(200))),
  license: z.optional(z.string().check(z.maxLength(200))),
});

export type OpenVsxIconExtension = {
  namespace: string;
  name: string;
  version: string;
  displayName: string;
  description: string | null;
};

const path = (...parts: string[]) => {
  const base = registry();
  return base
    ? new URL(
        `${base.pathname.replace(/\/$/, "")}/api/${parts.map(encodeURIComponent).join("/")}`,
        base,
      )
    : null;
};

/** Extensions matching `query` that contribute at least one file icon theme. */
async function search(
  query: string,
  signal?: AbortSignal,
): Promise<OpenVsxResult<OpenVsxIconExtension[]>> {
  const url = path("-", "search");
  if (!url) return { ok: false, error: badRegistry };
  url.search = new URLSearchParams({
    query: query.trim(),
    category: "Themes",
    size: "24",
    sortBy: "relevance",
  }).toString();
  const response = await request(url, 1024 * 1024, signal);
  if (!response.ok) return response;
  const parsed = searchSchema.safeParse(parseJson(response.value));
  if (!parsed.success)
    return {
      ok: false,
      error:
        "Open VSX returned an unreadable search result. Try again shortly.",
    };
  // The search does not say what an extension contributes; its package.json does.
  const checked = await Promise.all(
    parsed.data.extensions.map(async (extension) => {
      const manifest = path(
        extension.namespace,
        extension.name,
        extension.version,
        "file",
        "package.json",
      );
      if (!manifest) return null;
      const bytes = await request(manifest, 2 * 1024 * 1024, signal);
      if (!bytes.ok) return null;
      const contributes = manifestSchema.safeParse(parseJson(bytes.value));
      return contributes.success &&
        (contributes.data.contributes?.iconThemes?.length ?? 0) > 0
        ? {
            namespace: extension.namespace,
            name: extension.name,
            version: extension.version,
            displayName: extension.displayName ?? extension.name,
            description: extension.description ?? null,
          }
        : null;
    }),
  );
  return {
    ok: true,
    value: checked.filter((extension) => extension !== null).slice(0, 12),
  };
}

export type DownloadedExtension = {
  namespace: string;
  name: string;
  version: string;
  displayName: string;
  bytes: Uint8Array;
};

/**
 * Downloads an extension's VSIX and checks it against the sha256 Open VSX publishes, or against
 * `pinned.sha256` when the caller pins a version.
 */
async function download(
  namespace: string,
  name: string,
  options: { limit: number; pinned?: { version: string; sha256: string } },
): Promise<OpenVsxResult<DownloadedExtension>> {
  if (
    !identifier.safeParse(namespace).success ||
    !identifier.safeParse(name).success
  )
    return { ok: false, error: "That is not an Open VSX extension name." };
  let version = options.pinned?.version;
  let displayName = name;
  if (!version) {
    const url = path(namespace, name);
    if (!url) return { ok: false, error: badRegistry };
    const detail = await request(url, 1024 * 1024);
    if (!detail.ok) return detail;
    const parsed = detailSchema.safeParse(parseJson(detail.value));
    if (!parsed.success)
      return {
        ok: false,
        error:
          "Open VSX returned unreadable details for this extension. Try again shortly.",
      };
    version = parsed.data.version;
    displayName = parsed.data.displayName ?? name;
  }
  const file = `${namespace}.${name}-${version}`;
  const vsix = path(namespace, name, version, "file", `${file}.vsix`);
  const checksum = path(namespace, name, version, "file", `${file}.sha256`);
  if (!vsix || !checksum) return { ok: false, error: badRegistry };
  let expected = options.pinned?.sha256;
  if (!expected) {
    const published = await request(checksum, 1024);
    // Open VSX publishes a checksum for each release; older ones may lack it.
    if (published.ok) {
      const text =
        new TextDecoder().decode(published.value).trim().split(/\s+/)[0] ?? "";
      if (!/^[a-f0-9]{64}$/i.test(text))
        return {
          ok: false,
          error:
            "Open VSX published an unreadable checksum for this extension. Nothing was installed.",
        };
      expected = text.toLowerCase();
    }
  }
  const bytes = await request(vsix, options.limit);
  if (!bytes.ok) return bytes;
  if (expected) {
    const actual = createHash("sha256").update(bytes.value).digest("hex");
    if (actual !== expected)
      return {
        ok: false,
        error: `The downloaded ${displayName} does not match the checksum Open VSX publishes, so it was discarded. Try again later. Nothing was installed.`,
      };
  }
  return {
    ok: true,
    value: { namespace, name, version, displayName, bytes: bytes.value },
  };
}

export const OpenVsxClient = { search, download } as const;
