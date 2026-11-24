import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Where installed releases live (see docs/updates.md): a store the image creates at build time,
 * `/var/lib/nimbus`, apart from the config root the servers write.
 *
 * - the store and `releases/` (installed releases and `state.json`) belong to `owner` (root
 *   when the users are split) and nobody else may write them;
 * - `staging/` belongs to the update user, where the installer unpacks, and nobody else but
 *   `owner`'s group may enter it;
 * - every folder above the store belongs to root, `owner`, or a user this user namespace does not
 *   map (shown as the overflow id, which nobody inside can act as), and nobody else may write it
 *   unless it is sticky, as /var/tmp is.
 *
 * The servers' user may read and traverse `releases/` and nothing more.
 */
export type UpdateStore = { root: string; releases: string; staging: string };

export const UpdateStore = {
  /** The image's own store. */
  image: "/var/lib/nimbus",

  at(root: string): UpdateStore {
    return {
      root,
      releases: path.join(root, "releases"),
      staging: path.join(root, "staging"),
    };
  },

  /** Whether `store` is laid out as above, or why not, without changing anything. */
  async check(
    store: UpdateStore,
    { owner, update }: { owner: number; update: number },
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const refuse = (message: string) => ({
      ok: false as const,
      message: `The update store ${store.root} is not laid out as Nimbus needs (${message}), so updates are off; installed releases still start if they verify. See docs/updates.md, The update store.`,
    });
    const overflow = Number(
      (
        await readFile("/proc/sys/kernel/overflowuid", "utf8").catch(
          () => "65534",
        )
      ).trim(),
    );
    for (
      let folder = path.dirname(path.resolve(store.root));
      ;
      folder = path.dirname(folder)
    ) {
      const stats = await lstat(folder).catch(() => null);
      if (!stats?.isDirectory()) return refuse(`${folder} is not a folder`);
      if (stats.uid !== 0 && stats.uid !== owner && stats.uid !== overflow)
        return refuse(`${folder} belongs to user ${stats.uid}`);
      if (stats.mode & 0o022 && !(stats.mode & 0o1000))
        return refuse(`others may change ${folder}`);
      if (folder === path.dirname(folder)) break;
    }
    const own = async (folder: string, otherBits: number, uid: number) => {
      const stats = await lstat(folder).catch(() => null);
      if (!stats?.isDirectory()) return `${folder} is not a folder`;
      if (stats.uid !== uid)
        return `${folder} belongs to user ${stats.uid}, not ${uid}`;
      if (stats.mode & otherBits)
        return `${folder} has mode ${(stats.mode & 0o7777).toString(8)}`;
      return null;
    };
    const wrong =
      (await own(store.root, 0o7022, owner)) ??
      (await own(store.releases, 0o7022, owner)) ??
      (await own(store.staging, 0o7027, update));
    return wrong ? refuse(wrong) : { ok: true };
  },
} as const;
