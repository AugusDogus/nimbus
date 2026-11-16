import { describe, expect, it } from "bun:test";
import { ClientIp, TrustedProxies } from "./client-ip";

describe("ClientIp.resolve", () => {
  const none = TrustedProxies.parse(undefined);
  const proxies = TrustedProxies.parse("127.0.0.1, 10.0.0.0/8, fd00::/8");

  it("ignores forwarding headers when no proxy is trusted", () => {
    expect(ClientIp.resolve("203.0.113.9", "198.51.100.1", none)).toBe(
      "203.0.113.9",
    );
  });
  it("ignores forwarding headers from an untrusted peer", () => {
    expect(ClientIp.resolve("203.0.113.9", "198.51.100.1", proxies)).toBe(
      "203.0.113.9",
    );
  });
  it("takes the nearest untrusted hop behind trusted proxies", () => {
    expect(
      ClientIp.resolve(
        "::ffff:127.0.0.1",
        "6.6.6.6, 198.51.100.1, 10.1.2.3",
        proxies,
      ),
    ).toBe("198.51.100.1");
  });
  it("does not let a client prepend a spoofed address", () => {
    expect(
      ClientIp.resolve("127.0.0.1", ["1.1.1.1", "198.51.100.1"], proxies),
    ).toBe("198.51.100.1");
  });
  it("stops at a malformed hop", () => {
    expect(
      ClientIp.resolve("127.0.0.1", "198.51.100.1, garbage", proxies),
    ).toBe("127.0.0.1");
  });
  it("uses the outermost trusted hop when every hop is trusted", () => {
    expect(ClientIp.resolve("127.0.0.1", "10.0.0.5", proxies)).toBe("10.0.0.5");
  });
});

describe("TrustedProxies.parse", () => {
  it("rejects invalid entries with the offending value", () => {
    expect(() => TrustedProxies.parse("10.0.0.0/33")).toThrow('"10.0.0.0/33"');
    expect(() => TrustedProxies.parse("proxy.local")).toThrow('"proxy.local"');
  });
});

describe("ClientIp.bucket", () => {
  it("groups IPv6 addresses by /64 and keeps IPv4 addresses", () => {
    expect(ClientIp.bucket("2001:db8:0:1::5")).toBe("2001:db8:0:1::/64");
    expect(ClientIp.bucket("2001:db8:0:1:ffff:1:2:3")).toBe(
      "2001:db8:0:1::/64",
    );
    expect(ClientIp.bucket("::1")).toBe("0:0:0:0::/64");
    expect(ClientIp.bucket("198.51.100.1")).toBe("198.51.100.1");
  });
});
