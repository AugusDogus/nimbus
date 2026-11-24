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

/** IPv6 `address` as its 16 bytes, or null when it is not one (a zone index included). */
function ipv6(address: string): number[] | null {
  if (address.includes("%")) return null;
  let text = address.toLowerCase();
  // A trailing dotted IPv4 part stands for the last two groups.
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const value = ipv4(dotted[2] ?? "");
    if (value === null) return null;
    text = `${dotted[1]}${Math.floor(value / 65536).toString(16)}:${(value % 65536).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string | undefined): string[] =>
    part ? part.split(":") : [];
  const head = groups(halves[0]);
  const tail = groups(halves[1]);
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [
    ...head,
    ...Array<string>(halves.length === 1 ? 0 : missing).fill("0"),
    ...tail,
  ];
  const bytes: number[] = [];
  for (const group of all) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
}

/** Whether the IPv4 address in `bytes` (four of them) is public. */
const publicV4Bytes = (bytes: number[]) => publicAddress(bytes.join("."));

/**
 * Whether `address` (an IP literal) is a public address a redirect may lead to. IPv6 forms of
 * IPv4 addresses (mapped, translated, compatible, NAT64, 6to4) are judged by the IPv4 address they
 * carry, however they are written; other IPv6 addresses must be global unicast, outside the
 * documentation, Teredo and discard ranges.
 */
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
  if (kind !== 6) return false;
  const bytes = ipv6(address);
  if (!bytes) return false;
  const zero = (from: number, to: number) =>
    bytes.slice(from, to).every((byte) => byte === 0);
  const last4 = bytes.slice(12, 16);
  // ::ffff:a.b.c.d (mapped) and ::ffff:0:a.b.c.d (translated).
  if (zero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff)
    return publicV4Bytes(last4);
  if (zero(0, 8) && bytes[8] === 0xff && bytes[9] === 0xff && zero(10, 12))
    return publicV4Bytes(last4);
  // ::a.b.c.d (compatible), and :: and ::1 among them.
  if (zero(0, 12)) return zero(12, 15) ? false : publicV4Bytes(last4);
  // 64:ff9b::/96 (NAT64) and 64:ff9b:1::/48 (its local use).
  if (
    bytes[0] === 0 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b
  )
    return zero(4, 12) ? publicV4Bytes(last4) : false;
  // 2002::/16 (6to4) carries an IPv4 address in its next four bytes.
  if (bytes[0] === 0x20 && bytes[1] === 0x02)
    return publicV4Bytes(bytes.slice(2, 6));
  const first = bytes[0] ?? 0;
  // Only global unicast, 2000::/3.
  if ((first & 0xe0) !== 0x20) return false;
  // 2001::/32 (Teredo) and 2001:db8::/32 (documentation).
  if (first === 0x20 && bytes[1] === 0x01) {
    if (bytes[2] === 0 && bytes[3] === 0) return false;
    if (bytes[2] === 0x0d && bytes[3] === 0xb8) return false;
  }
  return true;
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
          message:
            "NIMBUS_UPDATE_SOURCE is set to something that is not a URL, so updates are off. Set it to off or to an https URL.",
        };
      }
      // Plain http only to this machine, as a test source or a local mirror behind a proxy.
      if (
        base.protocol !== "https:" &&
        !(base.protocol === "http:" && isLoopback(base.hostname))
      )
        return {
          ok: false,
          message:
            "NIMBUS_UPDATE_SOURCE must be an https URL (plain http only for localhost), so updates are off. Change it to an https URL.",
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
        // The transport's own text may name the address or what is behind it, so it is not shown.
        return fail(
          error instanceof Error &&
            (error.name === "TimeoutError" || error.name === "AbortError")
            ? `Could not fetch ${named}: it did not answer within ${Math.round(timeoutMs / 1000)} seconds. Try again later; if it keeps failing, check the server's network access.`
            : `Could not fetch ${named}: the connection failed. Try again later; if it keeps failing, check the server's network access and NIMBUS_UPDATE_SOURCE.`,
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
