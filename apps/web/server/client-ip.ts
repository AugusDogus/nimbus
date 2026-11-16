import { BlockList, isIP } from "node:net";

/**
 * The custom server derives the client address once per request and forwards it to
 * Next.js in this header, replacing any value the client sent.
 */
export const clientIpHeader = "x-nimbus-client-ip";

/** Proxies whose X-Forwarded-For entries are believed. Empty means forwarding headers are ignored. */
export type TrustedProxies = { list: BlockList; empty: boolean };

const unmap = (address: string) =>
  address.toLowerCase().startsWith("::ffff:") && isIP(address.slice(7)) === 4
    ? address.slice(7)
    : address;

export const TrustedProxies = {
  /**
   * Parses NIMBUS_TRUSTED_PROXIES: comma-separated addresses or CIDR ranges such as
   * `127.0.0.1, 10.0.0.0/8, fd00::/8`. Throws at startup on invalid input.
   */
  parse(value: string | undefined): TrustedProxies {
    const list = new BlockList();
    const entries = (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    for (const entry of entries) {
      const [address = "", prefix, extra] = entry.split("/");
      const family = isIP(address);
      const bits = prefix === undefined ? undefined : Number(prefix);
      const max = family === 4 ? 32 : 128;
      if (
        family === 0 ||
        extra !== undefined ||
        (bits !== undefined && (!/^\d{1,3}$/.test(prefix ?? "") || bits > max))
      )
        throw new Error(
          `NIMBUS_TRUSTED_PROXIES contains "${entry}", which is not an IP address or CIDR range. Use values like 127.0.0.1 or 10.0.0.0/8, separated by commas, or leave it unset when Nimbus is not behind a proxy.`,
        );
      const type = family === 4 ? "ipv4" : "ipv6";
      if (bits === undefined) list.addAddress(address, type);
      else list.addSubnet(address, bits, type);
    }
    return { list, empty: entries.length === 0 };
  },
  includes(proxies: TrustedProxies, address: string) {
    const normalized = unmap(address);
    const family = isIP(normalized);
    if (family === 0) return false;
    return proxies.list.check(normalized, family === 4 ? "ipv4" : "ipv6");
  },
} as const;

export const ClientIp = {
  /**
   * Walks X-Forwarded-For from the nearest hop outward while each hop is a trusted
   * proxy. The first untrusted hop is the client. Without trusted proxies the socket
   * peer is the client, so a client cannot choose its own address.
   */
  resolve(
    peer: string | undefined,
    forwardedFor: string | string[] | undefined,
    proxies: TrustedProxies,
  ): string {
    let current = unmap(peer ?? "");
    if (proxies.empty || !TrustedProxies.includes(proxies, current))
      return current || "unknown";
    const hops = (
      Array.isArray(forwardedFor)
        ? forwardedFor.join(",")
        : (forwardedFor ?? "")
    )
      .split(",")
      .map((hop) => unmap(hop.trim()));
    for (let index = hops.length - 1; index >= 0; index--) {
      const hop = hops[index] ?? "";
      if (isIP(hop) === 0) return current;
      current = hop;
      if (!TrustedProxies.includes(proxies, hop)) return hop;
    }
    return current;
  },
  /** Rate limits bucket IPv6 clients by /64, the smallest block a host usually controls. */
  bucket(address: string): string {
    if (isIP(address) !== 6) return address;
    const [head = "", tail = ""] = address.toLowerCase().split("::");
    const left = head ? head.split(":") : [];
    const right = tail ? tail.split(":") : [];
    const groups = address.includes("::")
      ? [
          ...left,
          ...Array<string>(8 - left.length - right.length).fill("0"),
          ...right,
        ]
      : left;
    return `${groups
      .slice(0, 4)
      .map((group) => Number.parseInt(group || "0", 16).toString(16))
      .join(":")}::/64`;
  },
  /** Reads the address that the custom server attached to a request. */
  fromHeaders(headers: Headers): string {
    return headers.get(clientIpHeader) ?? "unknown";
  },
} as const;
