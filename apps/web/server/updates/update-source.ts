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
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { "user-agent": "Nimbus", accept: "*/*" },
        credentials: "omit",
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return {
        ok: false,
        error: {
          kind: "fetch-failed",
          message: `Could not fetch ${url.href} (${error instanceof Error ? error.message : String(error)}).`,
        },
      };
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return {
        ok: false,
        error: {
          kind: "fetch-failed",
          message: `${url.href} answered ${response.status}${response.status === 404 ? ": nothing is published there" : ""}.`,
        },
      };
    }
    const declared = Number(response.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body.cancel();
      return {
        ok: false,
        error: {
          kind: "fetch-failed",
          message: `${url.href} is ${declared} bytes, more than the ${maxBytes} expected.`,
        },
      };
    }
    let read = 0;
    const capped = response.body.pipeThrough(
      new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
        transform(chunk, controller) {
          read += chunk.byteLength;
          if (read > maxBytes)
            controller.error(
              new Error(
                `${url.href} sent more than the ${maxBytes} bytes expected.`,
              ),
            );
          else controller.enqueue(chunk);
        },
      }),
    );
    return { ok: true, value: capped };
  },

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
