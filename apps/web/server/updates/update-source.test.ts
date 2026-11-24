import { expect, test } from "bun:test";
import type { BuildInfo } from "./build-info";
import { UpdateSource } from "./update-source";

const build: BuildInfo = {
  repository: "example/nimbus",
  commit: "a".repeat(40),
  sequence: 100,
  channel: "edge",
  image: "ghcr.io/example/nimbus:edge",
};

test("unset, the source is the channel's release in the repository the image was built from", () => {
  const source = UpdateSource.fromEnvironment(undefined, build);
  expect(
    source.ok && source.value.kind === "url" && source.value.base.href,
  ).toBe("https://github.com/example/nimbus/releases/download/channel-edge/");
  const none = UpdateSource.fromEnvironment(undefined, null);
  expect(none.ok && none.value.kind).toBe("off");
});

test("off turns updates off, and a configured source must be a plain https URL", () => {
  expect(UpdateSource.fromEnvironment("off", build)).toMatchObject({
    ok: true,
    value: { kind: "off" },
  });
  const mirror = UpdateSource.fromEnvironment(
    "https://mirror.example.test/nimbus",
    build,
  );
  expect(
    mirror.ok && mirror.value.kind === "url" && mirror.value.base.href,
  ).toBe("https://mirror.example.test/nimbus/");
  for (const refused of [
    "http://mirror.example.test/",
    "https://user:secret@mirror.example.test/",
    "https://mirror.example.test/?instance=1",
    "ftp://mirror.example.test/",
    "not a url",
  ])
    expect(UpdateSource.fromEnvironment(refused, build).ok).toBe(false);
  expect(UpdateSource.fromEnvironment("http://127.0.0.1:8080/", build).ok).toBe(
    true,
  );
  // What was set is never repeated: it may carry a secret, as a user and password.
  for (const refused of [
    "https://user:hunter2@mirror.example.test/",
    "ftp://hunter2.example.test/",
    "hunter2",
  ]) {
    const result = UpdateSource.fromEnvironment(refused, build);
    expect(result.ok || result.message).not.toContain("hunter2");
  }
});

test("only plain file names are fetched from a source", () => {
  const source = UpdateSource.fromEnvironment(
    "https://mirror.example.test/",
    build,
  );
  if (!source.ok || source.value.kind !== "url") throw new Error("no source");
  const url = source.value;
  expect(UpdateSource.url(url, "manifest.json").href).toBe(
    "https://mirror.example.test/manifest.json",
  );
  for (const name of [
    "../secrets",
    "/etc/passwd",
    ".hidden",
    "a/b",
    "https://elsewhere.test/x",
  ])
    expect(() => UpdateSource.url(url, name)).toThrow();
});

test("a fetch is cut off past its limit, and sends nothing identifying", async () => {
  const seen: Headers[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      seen.push(request.headers);
      return new Response(new Uint8Array(5000));
    },
  });
  try {
    const url = new URL(`http://127.0.0.1:${server.port}/manifest.json`);
    const capped = await UpdateSource.fetchBytes(url, {
      maxBytes: 1000,
      timeoutMs: 5000,
    });
    expect(capped.ok).toBe(false);
    const whole = await UpdateSource.fetchBytes(url, {
      maxBytes: 5000,
      timeoutMs: 5000,
    });
    expect(whole.ok && whole.value.byteLength).toBe(5000);
    expect(seen[0]?.get("user-agent")).toBe("Nimbus");
    expect(seen[0]?.get("cookie")).toBeNull();
    expect(seen[0]?.get("authorization")).toBeNull();
  } finally {
    await server.stop(true);
  }
});

test("a redirect is followed only to a public https address, a few hops at most, and errors name no source address", async () => {
  let hops = 0;
  let port = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request): Response {
      const name = new URL(request.url).pathname.slice(1);
      if (name === "to-loopback")
        return Response.redirect(`http://127.0.0.1:${port}/manifest.json`, 302);
      if (name === "to-metadata")
        return Response.redirect(
          "https://169.254.169.254/latest/meta-data",
          302,
        );
      if (name === "to-private")
        return Response.redirect("https://10.1.2.3/manifest.json", 302);
      if (name === "to-plain-http")
        return Response.redirect(
          "http://mirror.example.test/manifest.json",
          302,
        );
      if (name === "loop") {
        hops++;
        return Response.redirect(`http://127.0.0.1:${port}/loop`, 302);
      }
      return new Response("ok");
    },
  });
  port = server.port ?? 0;
  try {
    const base = `http://127.0.0.1:${server.port}/`;
    for (const name of [
      "to-loopback",
      "to-metadata",
      "to-private",
      "to-plain-http",
      "loop",
    ]) {
      const fetched = await UpdateSource.fetchBytes(new URL(name, base), {
        maxBytes: 1000,
        timeoutMs: 5000,
      });
      expect({ name, ok: fetched.ok }).toEqual({ name, ok: false });
      if (!fetched.ok) {
        expect(fetched.error.message).not.toContain(String(server.port));
        expect(fetched.error.message).toContain(name);
      }
    }
    expect(hops).toBeLessThanOrEqual(1);
  } finally {
    await server.stop(true);
  }
});

test("addresses a redirect may not lead to", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.4.4",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    // The same addresses as URL parsers write them, and other IPv6 forms of IPv4 ones.
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:a9fe:a9fe",
    "::ffff:0:a00:1",
    "::7f00:1",
    "64:ff9b::a9fe:a9fe",
    "2002:c0a8:101::1",
    "::",
    "ff02::1",
    "2001:db8::1",
    new URL("https://[::ffff:169.254.169.254]/").hostname.slice(1, -1),
  ])
    expect({ address, public: UpdateSource.publicAddress(address) }).toEqual({
      address,
      public: false,
    });
  for (const address of [
    "140.82.112.3",
    "2606:4700::6810:84e5",
    "::ffff:8c52:7003",
  ])
    expect({ address, public: UpdateSource.publicAddress(address) }).toEqual({
      address,
      public: true,
    });
});

test("a source that cannot be reached is named by its file alone, without the transport's own text", async () => {
  const probe = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data: () => undefined },
  });
  const closed = probe.port;
  probe.stop(true);
  const fetched = await UpdateSource.fetchBytes(
    new URL(`http://127.0.0.1:${closed}/manifest.json`),
    { maxBytes: 1000, timeoutMs: 5000 },
  );
  expect(fetched.ok).toBe(false);
  if (!fetched.ok) {
    expect(fetched.error.message).toContain("manifest.json");
    expect(fetched.error.message).not.toContain(String(closed));
    expect(fetched.error.message).not.toContain("127.0.0.1");
    expect(fetched.error.message).not.toMatch(/ECONN|Unable to connect|errno/i);
  }
});
