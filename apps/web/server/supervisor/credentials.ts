import { readdir, readFile } from "node:fs/promises";

/**
 * A process's users, groups and capabilities, as `/proc/<pid>/status` gives them: what the
 * supervisor checks a child has after `setpriv` dropped privileges (see Users), and how it finds
 * every process of the update user.
 */
export type Credentials = {
  /** Real, effective, saved and filesystem ids. */
  uids: number[];
  gids: number[];
  groups: number[];
  capabilities: {
    inheritable: bigint;
    permitted: bigint;
    effective: bigint;
    bounding: bigint;
    ambient: bigint;
  };
  noNewPrivs: boolean;
};

export type Ids = { uid: number; gid: number };

function parse(status: string): Credentials | null {
  const field = (name: string) =>
    new RegExp(`^${name}:[ \\t]*(.*)$`, "m").exec(status)?.[1]?.trim();
  const numbers = (value: string | undefined) =>
    value === undefined
      ? null
      : value === ""
        ? []
        : value
            .split(/\s+/)
            .map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  const mask = (value: string | undefined) =>
    value !== undefined && /^[0-9a-f]+$/.test(value)
      ? BigInt(`0x${value}`)
      : null;
  const uids = numbers(field("Uid"));
  const gids = numbers(field("Gid"));
  const groups = numbers(field("Groups"));
  const inheritable = mask(field("CapInh"));
  const permitted = mask(field("CapPrm"));
  const effective = mask(field("CapEff"));
  const bounding = mask(field("CapBnd"));
  const ambient = mask(field("CapAmb"));
  const noNewPrivs = field("NoNewPrivs");
  if (
    !uids ||
    !gids ||
    !groups ||
    [...uids, ...gids, ...groups].some(Number.isNaN) ||
    uids.length !== 4 ||
    gids.length !== 4 ||
    inheritable === null ||
    permitted === null ||
    effective === null ||
    bounding === null ||
    ambient === null ||
    (noNewPrivs !== "0" && noNewPrivs !== "1")
  )
    return null;
  return {
    uids,
    gids,
    groups,
    capabilities: { inheritable, permitted, effective, bounding, ambient },
    noNewPrivs: noNewPrivs === "1",
  };
}

/** `pid`'s credentials, or null when it is gone or they cannot be read. */
async function read(pid: number): Promise<Credentials | null> {
  const status = await readFile(`/proc/${pid}/status`, "utf8").catch(
    () => null,
  );
  return status === null ? null : parse(status);
}

export const Credentials = {
  parse,
  read,

  /**
   * Why `credentials` are not exactly `ids` with nothing more (no other id, no supplementary
   * group, no capability in any set, `no_new_privs`), or null when they are.
   */
  dropped(credentials: Credentials | null, ids: Ids): string | null {
    if (!credentials) return "its credentials could not be read";
    if (credentials.uids.some((uid) => uid !== ids.uid))
      return `it runs as users ${credentials.uids.join(", ")}, not ${ids.uid} alone`;
    if (credentials.gids.some((gid) => gid !== ids.gid))
      return `it runs as groups ${credentials.gids.join(", ")}, not ${ids.gid} alone`;
    if (credentials.groups.length)
      return `it keeps supplementary groups ${credentials.groups.join(", ")}`;
    const held = Object.entries(credentials.capabilities).filter(
      ([, value]) => value !== 0n,
    );
    if (held.length)
      return `it holds capabilities (${held.map(([set, value]) => `${set} ${value.toString(16)}`).join(", ")})`;
    if (!credentials.noNewPrivs)
      return "it may gain privileges (no_new_privs is off)";
    return null;
  },

  /**
   * Why `pid` has not dropped to `ids` with nothing more (see `dropped`), or null as soon as a
   * look shows it has. setpriv drops in steps, the user first while keeping its capabilities,
   * then the groups, the bounding and ambient sets, and the permitted set only at exec, so a
   * look in between sees a mix that is no verdict yet. Judged on the last of at most `tries`
   * looks (by `look`) `intervalMs` apart while `running`; "it did not start" if it never ran.
   */
  async untilDropped(
    pid: number,
    ids: Ids,
    {
      running,
      tries = 100,
      intervalMs = 20,
      look = read,
    }: {
      running: () => boolean;
      tries?: number;
      intervalMs?: number;
      look?: (pid: number) => Promise<Credentials | null>;
    },
  ): Promise<string | null> {
    let wrong = "it did not start";
    for (let left = tries; left > 0 && running(); left--) {
      const reason = Credentials.dropped(await look(pid), ids);
      if (reason === null) return null;
      wrong = reason;
      await Bun.sleep(intervalMs);
    }
    return wrong;
  },

  /** Every process any of whose user ids is `uid`. */
  async processesOf(uid: number): Promise<number[]> {
    const found: number[] = [];
    for (const name of await readdir("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const credentials = await Credentials.read(Number(name));
      if (credentials?.uids.includes(uid)) found.push(Number(name));
    }
    return found;
  },
} as const;
