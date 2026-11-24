import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { BuildInfo } from "./build-info";

/**
 * Where an installation fetches release manifests and bundles (see docs/updates.md): a base URL
 * serving `manifest.json`, `manifest.sig` and the bundle a manifest names.
 *
 * NIMBUS_UPDATE_SOURCE sets it: `off` turns updates off, so the server makes no request for its
 * own code; an https URL names a mirror or a fork's releases. Unset, it is the GitHub release of
 * the image's channel in the repository the image was built from, from the image's build
 * metadata; an image without build metadata, such as a checkout, has none.
 */
export type UpdateSource =
  | { kind: "off"; reason: string }
  | { kind: "url"; base: URL; origin: "configured" | "default" };

export type FetchError = { kind: "fetch-failed"; message: string };

const isLoopback = (host: string) =>
  host === "localhost" || host === "127.0.0.1" || host === "[::1]";

/** Redirects a fetch follows at most. */
const MAX_REDIRECTS = 3;

/** IPv4 `address` as a number, or null. */
function ipv4(address: string) {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return null;
  return parts.reduce((value, part) => value * 256 + part, 0);
}

/** IPv4 ranges no redirect may lead to: this host, private networks, link-local, CGNAT. */
const blockedV4: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
];

/** Whether `address` (an IP literal) is a public address a redirect may lead to. */
function publicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const value = ipv4(address);
    if (value === null) return false;
    return !blockedV4.some(([base, bits]) => {
      const start = ipv4(base) ?? 0;
      const size = 2 ** (32 - bits);
      return value >= start && value < start + size;
    });
  }
  if (kind === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
    if (mapped) return publicAddress(mapped);
    if (lower === "::" || lower === "::1") return false;
    // Link-local fe80::/10, unique local fc00::/7, multicast ff00::/8.
    return !/^(fe[89ab]|f[cd]|ff)/.test(lower);
  }
  return false;
}

/** Whether `url` is https and every address its host has is public; why not otherwise. */
async function publicDestination(
  url: URL,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (url.protocol !== "https:")
    return { ok: false, reason: "to a plain http address" };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host))
    return publicAddress(host)
      ? { ok: true }
      : { ok: false, reason: "to a private or local address" };
  if (host === "localhost" || host.endsWith(".localhost"))
    return { ok: false, reason: "to this machine" };
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return { ok: false, reason: "to a host that does not resolve" };
  }
  return addresses.length &&
    addresses.every((one) => publicAddress(one.address))
    ? { ok: true }
    : { ok: false, reason: "to a host with a private or local address" };
}

export const UpdateSource = {
  fromEnvironment(
    value: string | undefined,
    build: BuildInfo | null,
  ): { ok: true; value: UpdateSource } | { ok: false; message: string } {
    const configured = value?.trim();
    if (configured === "off")
      return {
        ok: true,
        value: {
          kind: "off",
          reason:
            "NIMBUS_UPDATE_SOURCE is off, so Nimbus does not look for updates.",
        },
      };
    if (configured) {
      let base: URL;
      try {
        base = new URL(
          configured.endsWith("/") ? configured : `${configured}/`,
        );
      } catch {
        return {
          ok: false,
          message: `NIMBUS_UPDATE_SOURCE must be off or an https URL; got ${configured}.`,
        };
      }
      // Plain http only to this machine, as a test source or a local mirror behind a proxy.
      if (
        base.protocol !== "https:" &&
        !(base.protocol === "http:" && isLoopback(base.hostname))
      )
        return {
          ok: false,
          message: `NIMBUS_UPDATE_SOURCE must use https (plain http only for localhost); got ${configured}.`,
        };
      if (base.username || base.password || base.search || base.hash)
        return {
          ok: false,
          message:
            "NIMBUS_UPDATE_SOURCE must be a plain URL, without a user, password, query or fragment: Nimbus sends nothing but the file names it fetches.",
        };
      return { ok: true, value: { kind: "url", base, origin: "configured" } };
    }
    if (!build)
      return {
        ok: true,
        value: {
          kind: "off",
          reason:
            "This release has no build metadata (build-info.json), so it does not know where its updates are published. Set NIMBUS_UPDATE_SOURCE to look for them.",
        },
      };
    return {
      ok: true,
      value: {
        kind: "url",
        base: new URL(
          `https://github.com/${build.repository}/releases/download/channel-${build.channel}/`,
        ),
        origin: "default",
      },
    };
  },

  /** `file` at `source`: a name, never a path, so nothing outside the source is fetched. */
  url(source: Extract<UpdateSource, { kind: "url" }>, file: string) {
    if (!/^[\w.-]{1,200}$/.test(file) || file.startsWith("."))
      throw new Error(
        `Refusing to fetch ${JSON.stringify(file)}: not a file name.`,
      );
    return new URL(file, source.base);
  },

  /**
   * GET `url` with nothing identifying: no cookies or credentials, a plain user agent. At most
   * `maxBytes` are read; more, or no answer within `timeoutMs`, fails.
   */
  async fetch(
    url: URL,
    { maxBytes, timeoutMs }: { maxBytes: number; timeoutMs: number },
  ): Promise<
    | { ok: true; value: ReadableStream<Uint8Array<ArrayBuffer>> }
    | { ok: false; error: FetchError }
  > {
    // Errors name the file, never the source's address, which may say more than it should.
    const named = `the update source's ${url.pathname.split("/").pop() || "file"}`;
    const fail = (message: string) => ({
      ok: false as const,
      error: { kind: "fetch-failed" as const, message },
    });
    const signal = AbortSignal.timeout(timeoutMs);
    let target = url;
    let response: Response;
    for (let hop = 0; ; hop++) {
      try {
        response = await fetch(target, {
          headers: { "user-agent": "Nimbus", accept: "*/*" },
          credentials: "omit",
          redirect: "manual",
          signal,
        });
      } catch (error) {
        return fail(
          `Could not fetch ${named} (${error instanceof Error ? error.message.replaceAll(url.host, "the source") : String(error)}).`,
        );
      }
      const location = response.headers.get("location");
      if (![301, 302, 303, 307, 308].includes(response.status) || !location)
        break;
      await response.body?.cancel();
      if (hop >= MAX_REDIRECTS)
        return fail(
          `${named} redirected more than ${MAX_REDIRECTS} times, so it was not followed further.`,
        );
      let next: URL;
      try {
        next = new URL(location, target);
      } catch {
        return fail(`${named} redirected to an address that is not a URL.`);
      }
      // A source may send a client to its storage, as GitHub does, but only to a public https
      // address: never to this machine, its network, or a cloud's metadata service.
      const allowed = await publicDestination(next);
      if (!allowed.ok)
        return fail(
          `${named} redirected ${allowed.reason}, which Nimbus does not follow.`,
        );
      target = next;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return fail(
        `${named} answered ${response.status}${response.status === 404 ? ": nothing is published there" : ""}.`,
      );
    }
    const declared = Number(response.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body.cancel();
      return fail(
        `${named} is ${declared} bytes, more than the ${maxBytes} expected.`,
      );
    }
    let read = 0;
    const capped = response.body.pipeThrough(
      new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
        transform(chunk, controller) {
          read += chunk.byteLength;
          if (read > maxBytes)
            controller.error(
              new Error(
                `${named} sent more than the ${maxBytes} bytes expected.`,
              ),
            );
          else controller.enqueue(chunk);
        },
      }),
    );
    return { ok: true, value: capped };
  },

  publicAddress,

  /** All of a capped fetch's bytes. */
  async fetchBytes(url: URL, limits: { maxBytes: number; timeoutMs: number }) {
    const fetched = await UpdateSource.fetch(url, limits);
    if (!fetched.ok) return fetched;
    try {
      return {
        ok: true as const,
        value: new Uint8Array(await new Response(fetched.value).arrayBuffer()),
      };
    } catch (error) {
      return {
        ok: false as const,
        error: {
          kind: "fetch-failed" as const,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  },
} as const;
