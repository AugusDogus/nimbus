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
