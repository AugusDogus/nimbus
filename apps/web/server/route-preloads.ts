/**
 * Preload hints for the page at an address. The router loads a page's code-split route chunks
 * and its first data only after the app entry has run; listing them in the HTML lets the
 * browser fetch them while the entry downloads. Routes come from the Vite build manifest, so
 * this follows the route files without a second route list.
 */
type Manifest = Record<string, unknown>;

type Segment =
  | { kind: "static"; value: string }
  | { kind: "param" }
  | { kind: "splat" };

type RoutePreload = {
  segments: Segment[];
  /** Whether the route is a signed-in page, which first checks the session. */
  authed: boolean;
  /** Whether the route is a file browser page, which also loads the browsing preferences. */
  files: boolean;
  /** Whether the route is the public share page, which first loads the share. */
  share: boolean;
  chunks: string[];
};

export type RoutePreloads = {
  /** `<link>` tags for the page at `pathname`, or "" when nothing is known about it. */
  links(pathname: string): string;
};

const routePrefix = "routes/";
const splitSuffix = "?tsr-split=component";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function parse(file: string): Segment[] {
  return file
    .slice(routePrefix.length, -".tsx".length)
    .split("/")
    .filter((part) => !part.startsWith("_") && part !== "index")
    .map((part): Segment =>
      part === "$"
        ? { kind: "splat" }
        : part.startsWith("$")
          ? { kind: "param" }
          : { kind: "static", value: part },
    );
}

/** Literal segments outrank parameters, which outrank a splat, as in the router. */
function rank(segments: Segment[]) {
  return segments.map((segment) =>
    segment.kind === "static" ? 2 : segment.kind === "param" ? 1 : 0,
  );
}

function matches(segments: Segment[], parts: string[]) {
  for (const [index, segment] of segments.entries()) {
    if (segment.kind === "splat") return true;
    const part = parts[index];
    if (part === undefined) return false;
    if (segment.kind === "static" && segment.value !== part) return false;
  }
  return parts.length === segments.length;
}

/**
 * The file browser layout's first tRPC request, which asks for the preferences alone. If the
 * client ever batches it with other queries, this hint goes unused and nothing else changes.
 */
const prefsRequest = `/api/trpc/prefs.get?batch=1&input=${encodeURIComponent("{}")}`;

/** The token as the share page encodes it, which also makes it safe inside an attribute. */
function shareToken(part: string) {
  try {
    return encodeURIComponent(decodeURIComponent(part));
  } catch {
    return encodeURIComponent(part);
  }
}

export const RoutePreloads = {
  /** Reads route chunks from `manifest`, leaving out files the page already loads. */
  fromManifest(value: unknown): RoutePreloads {
    if (!isRecord(value))
      throw new Error(
        "The client build manifest is not an object. Run `bun run build` again, then restart Nimbus.",
      );
    const manifest: Manifest = value;
    const chunk = (key: string) => {
      const entry = manifest[key];
      return isRecord(entry) ? entry : undefined;
    };
    const fileOf = (key: string) => {
      const file = chunk(key)?.file;
      return typeof file === "string" ? file : undefined;
    };
    const collect = (key: string, into: Set<string>) => {
      const file = fileOf(key);
      if (!file?.endsWith(".js") || into.has(file)) return;
      into.add(file);
      const imports = chunk(key)?.imports;
      if (isStringArray(imports))
        for (const imported of imports) collect(imported, into);
    };
    const entry = new Set<string>();
    collect("index.html", entry);
    const routeFiles = Object.keys(manifest)
      .filter((key) => key.startsWith(routePrefix) && key.endsWith(splitSuffix))
      .map((key) => key.slice(0, -splitSuffix.length));
    const split = new Set(routeFiles);
    const routes: RoutePreload[] = routeFiles
      .filter(
        (file) =>
          !routeFiles.some((other) =>
            other.startsWith(`${file.slice(0, -4)}/`),
          ),
      )
      .map((file) => {
        const files = new Set<string>();
        const parts = file.slice(0, -".tsx".length).split("/");
        for (let depth = 2; depth <= parts.length; depth++) {
          const ancestor = `${parts.slice(0, depth).join("/")}.tsx`;
          if (split.has(ancestor)) collect(ancestor + splitSuffix, files);
        }
        return {
          segments: parse(file),
          authed: file.startsWith(`${routePrefix}_authed/`),
          files: file.startsWith(`${routePrefix}_authed/_files/`),
          share: file === `${routePrefix}s/$token.tsx`,
          chunks: [...files].filter((name) => !entry.has(name)),
        };
      })
      .sort((a, b) => {
        const [x, y] = [rank(a.segments), rank(b.segments)];
        for (let index = 0; index < Math.max(x.length, y.length); index++) {
          const difference = (y[index] ?? -1) - (x[index] ?? -1);
          if (difference !== 0) return difference;
        }
        return 0;
      });
    return {
      links(pathname) {
        const parts = pathname.split("/").filter(Boolean);
        const route = routes.find((candidate) =>
          matches(candidate.segments, parts),
        );
        if (!route) return "";
        const data = route.authed
          ? ["/api/auth/get-session", ...(route.files ? [prefsRequest] : [])]
          : route.share && parts[1]
            ? [`/api/share/${shareToken(parts[1])}?path=`]
            : [];
        return [
          ...data.map(
            (href) =>
              `<link rel="preload" as="fetch" crossorigin href="${href}">`,
          ),
          ...route.chunks.map(
            (file) => `<link rel="modulepreload" crossorigin href="/${file}">`,
          ),
        ].join("");
      },
    };
  },
} as const;
