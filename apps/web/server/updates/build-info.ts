import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * Which build a release tree is: `apps/web/build-info.json`, written by the image build and by
 * the bundle builder (scripts/release-bundle.ts). A checkout has none; it then runs no updates,
 * since it neither knows its place on a channel nor where its releases are published.
 */
export type BuildInfo = {
  /** The repository it was built from, as `owner/name`: where its releases are published. */
  repository: string;
  commit: string;
  /** Higher for every later build on the channel. */
  sequence: number;
  /** `edge` for builds of main, `stable` for version tags. */
  channel: string;
  /** The image a release may need instead, as a reference without digest. */
  image: string;
};

const schema = z.object({
  repository: z.string().regex(/^[\w.-]{1,100}\/[\w.-]{1,100}$/),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  sequence: z.number().int().positive(),
  channel: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  image: z.string().max(300),
});

export const BuildInfo = {
  file: (web: string) => path.join(web, "build-info.json"),

  /** The build of the tree whose apps/web is `web`: null without a file, an error when invalid. */
  async read(
    web: string,
  ): Promise<
    | { ok: true; value: BuildInfo | null }
    | { ok: false; error: { kind: "invalid-build-info"; message: string } }
  > {
    let text: string;
    try {
      text = await readFile(BuildInfo.file(web), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { ok: true, value: null };
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      value = null;
    }
    const parsed = schema.safeParse(value);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : {
          ok: false,
          error: {
            kind: "invalid-build-info",
            message: `${BuildInfo.file(web)} does not describe a build ({ repository, commit, sequence, channel, image }), so this release cannot take part in updates. Rebuild it.`,
          },
        };
  },

  encode: (info: BuildInfo) => `${JSON.stringify(info, null, 2)}\n`,
} as const;
