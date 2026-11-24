import { z } from "zod";

/**
 * The signed description of one release bundle (see docs/updates.md). It is parsed only after
 * its signature verified, from the exact bytes that were signed.
 */
export type ReleaseManifest = {
  format: 1;
  build: {
    /** Higher for every later build on the channel; what downgrade rules compare. */
    sequence: number;
    commit: string;
    channel: string;
    /** When CI published it, as an ISO time. */
    publishedAt: string;
    /** The repository it was built from, as `owner/name`. */
    repository: string;
  };
  /** The commits since the previous build on the channel, newest first. */
  notes: { commit: string; subject: string }[];
  requires: {
    /** The exact Bun version the image must run. */
    bun: string;
    supervisorProtocol: number;
    /** Native packages the image must provide, by exact version. */
    native: Record<string, string>;
    /** The image to pull when this one cannot run the release, as a reference without digest. */
    image: string;
  };
  migrations: {
    /** Every migration tag the release knows, in order. */
    tags: string[];
    /** Those safe beside an older server (see MigrationGate). */
    liveSafe: string[];
  };
  bundle: { file: string; size: number; sha256: string };
  /** The digest of the release tree the bundle unpacks to (see ReleaseTree), and its entries. */
  tree: { sha256: string; entries: number };
};

export type ManifestError = { kind: "invalid-manifest"; message: string };

/** The longest manifest accepted, so a hostile source cannot make the server read without end. */
export const MAX_MANIFEST_BYTES = 64 * 1024;

const hex = (length: number) =>
  z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`));
const channel = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const tag = z.string().regex(/^\d{4}_[\w-]{1,96}$/);
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/);

const schema = z.object({
  format: z.literal(1),
  build: z.object({
    sequence: z.number().int().positive(),
    commit: hex(40),
    channel,
    publishedAt: z.iso.datetime(),
    repository: z.string().regex(/^[\w.-]{1,100}\/[\w.-]{1,100}$/),
  }),
  notes: z
    .array(z.object({ commit: hex(40), subject: z.string().max(500) }))
    .max(500),
  requires: z.object({
    bun: version,
    supervisorProtocol: z.number().int().positive(),
    native: z.record(z.string().regex(/^(@[\w.-]+\/)?[\w.-]+$/), version),
    image: z.string().max(300),
  }),
  migrations: z.object({
    tags: z.array(tag).max(10_000),
    liveSafe: z.array(tag).max(10_000),
  }),
  bundle: z.object({
    file: z.string().regex(/^[\w.-]{1,200}\.tar\.gz$/),
    size: z
      .number()
      .int()
      .positive()
      .max(2 * 1024 ** 3),
    sha256: hex(64),
  }),
  tree: z.object({
    sha256: hex(64),
    entries: z.number().int().positive().max(1_000_000),
  }),
});

export const ReleaseManifest = {
  /** Parse signed manifest bytes. */
  parse(
    bytes: Uint8Array,
  ):
    | { ok: true; value: ReleaseManifest }
    | { ok: false; error: ManifestError } {
    if (bytes.byteLength > MAX_MANIFEST_BYTES)
      return {
        ok: false,
        error: {
          kind: "invalid-manifest",
          message: `The release manifest is ${bytes.byteLength} bytes, more than the ${MAX_MANIFEST_BYTES} a manifest may have.`,
        },
      };
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch (error) {
      return {
        ok: false,
        error: {
          kind: "invalid-manifest",
          message: `The release manifest is not JSON (${error instanceof Error ? error.message : String(error)}).`,
        },
      };
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      return {
        ok: false,
        error: {
          kind: "invalid-manifest",
          message: `The release manifest does not describe a release: ${z.prettifyError(parsed.error).replaceAll("\n", " ")}`,
        },
      };
    return { ok: true, value: parsed.data };
  },

  /** The bytes CI signs: the manifest as JSON, with a final newline. */
  encode(manifest: ReleaseManifest) {
    return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  },

  /** The directory name of the release under `releases/`: unique per build, never reused. */
  releaseName(manifest: ReleaseManifest) {
    return `${manifest.build.channel}-${manifest.build.sequence}-${manifest.build.commit.slice(0, 12)}`;
  },
} as const;
