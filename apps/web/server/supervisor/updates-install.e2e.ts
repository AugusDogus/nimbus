import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ReleaseManifest } from "../updates/release-manifest";
import { ControlClient } from "./control-client";
import { MiB, UpdatesHarness, built, filmSize } from "./updates-e2e-harness";

/**
 * In-app updates with real processes (see docs/updates.md), what installs and hands over: from
 * the built-in release to a signed bundle built by scripts/release-bundle.ts, while a film-sized
 * download streams from the server being replaced; an install refused while a restart runs; two
 * installs asked at once and a rollback; a restart that keeps the installed release; a rollback
 * that never takes a release of the same name from elsewhere; and an installed release verified
 * again after a crash, and set aside for the built-in one once changed. Needs the built client.
 * Its setup builds build 101 (about 15 seconds) and writes a 48 MiB film.
 */
const h = new UpdatesHarness();

describe.skipIf(!built)("in-app updates with real processes: installs", () => {
  beforeAll(() => h.setUp({ film: true }), 240_000);
  // A drain of at most NIMBUS_STOP_SECONDS, a sweep, and removing the release trees.
  afterAll(() => h.tearDown(), 60_000);

  test("an update installs and takes over while a download streams to its end from the server it replaced", async () => {
    expect(await h.active()).toBe("built-in");
    await h.publish(
      h.bundle101.manifest,
      new Uint8Array(await Bun.file(h.bundle101.archive).arrayBuffer()),
    );
    const checked = await ControlClient.checkForUpdate(h.socket);
    expect(checked.status).toBe(200);
    const film = h.stream(
      `${h.origin}/api/files/download?path=films/film.bin`,
      4 * MiB,
    );
    await Bun.sleep(1_000);
    // A gentle poll on fresh connections throughout, ten a second.
    let polling = true;
    const answers: number[] = [];
    const poll = (async () => {
      while (polling) {
        answers.push(await h.health().catch(() => 0));
        await Bun.sleep(100);
      }
    })();
    const done = await ControlClient.update(h.socket, "install");
    expect(done?.ok).toBe(true);
    expect(await h.active()).toBe(
      ReleaseManifest.releaseName(h.bundle101.manifest),
    );
    const played = await film;
    polling = false;
    await poll;
    expect(played.status).toBe(200);
    expect(played.received).toBe(filmSize);
    expect(played.mismatches).toBe(0);
    expect(answers.length).toBeGreaterThan(10);
    expect(answers.filter((code) => code !== 200)).toEqual([]);
  }, 120_000);

  test("an install asked for while a restart is under way is busy at once and changes nothing", async () => {
    const offered = await h.variant(107, h.bundle101.tree);
    await h.publish(offered.manifest, offered.bytes);
    expect((await ControlClient.checkForUpdate(h.socket)).status).toBe(200);
    const stateFile = path.join(h.root, "store/releases/state.json");
    const before = await Bun.file(stateFile).text();
    const restart = ControlClient.handover(h.socket, null);
    await h.waitFor("the restart to start", async () =>
      (await h.status()).phase === "handing-over" ? true : null,
    );
    const refused = await ControlClient.update(h.socket, "install");
    expect(refused?.ok).toBe(false);
    if (refused && !refused.ok) expect(refused.error.kind).toBe("busy");
    expect((await restart)?.ok).toBe(true);
    // Nothing was downloaded, reserved or marked as being switched to.
    expect(await Bun.file(stateFile).text()).toBe(before);
    expect(await readdir(path.join(h.root, "store/releases"))).not.toContain(
      ReleaseManifest.releaseName(offered.manifest),
    );
  }, 120_000);

  test("a newer release installs, and a rollback returns to the one before", async () => {
    const before = await h.active();
    const next = await h.variant(105, h.bundle101.tree);
    await h.publish(next.manifest, next.bytes);
    expect((await ControlClient.checkForUpdate(h.socket)).status).toBe(200);
    // Asked twice at once: one install runs, through its handover; the other is told so.
    const both = await Promise.all([
      ControlClient.update(h.socket, "install"),
      ControlClient.update(h.socket, "install"),
    ]);
    expect(both.filter((done) => done?.ok)).toHaveLength(1);
    const turnedAway = both.find((done) => done && !done.ok);
    if (turnedAway && !turnedAway.ok)
      expect(turnedAway.error.kind).toBe("busy");
    expect(await h.active()).toBe(ReleaseManifest.releaseName(next.manifest));
    expect((await ControlClient.update(h.socket, "rollback"))?.ok).toBe(true);
    expect(await h.active()).toBe(before);
    expect(await h.health()).toBe(200);
  }, 120_000);

  test("after a restart the installed release runs again, and an install that runs out of space leaves it serving", async () => {
    const before = await h.active();
    h.supervisor?.kill("SIGTERM");
    expect(await h.supervisor?.exited).toBe(0);
    // Every file the h.supervisor and its processes write may grow to 8 MiB, less than a bundle.
    await h.startSupervisor(["prlimit", `--fsize=${8 * MiB}`, "--"]);
    expect(await h.active()).toBe(before);
    const next = await h.variant(106, h.bundle101.tree);
    await h.publish(next.manifest, next.bytes);
    expect((await ControlClient.checkForUpdate(h.socket)).status).toBe(200);
    const full = await ControlClient.update(h.socket, "install");
    expect(full?.ok).toBe(false);
    if (full && !full.ok)
      expect(full.error.message).toContain(
        "full or limits how large a file may grow",
      );
    expect(await h.active()).toBe(before);
    expect(await h.health()).toBe(200);
    const left = await readdir(path.join(h.root, "store/releases"));
    expect(left).not.toContain(ReleaseManifest.releaseName(next.manifest));
  }, 120_000);

  test("a rollback starts only the installed release that ran before, verified, never one of the same name elsewhere", async () => {
    const running = await h.active();
    const state = z
      .object({ previous: z.string().nullable() })
      .parse(
        await Bun.file(path.join(h.root, "store/releases/state.json")).json(),
      );
    const previous = state.previous;
    if (!previous) throw new Error("Nothing ran before the running release.");
    // The installed copy is gone; an unsigned release of that name waits elsewhere.
    const installed = path.join(h.root, "store/releases", previous);
    const aside = path.join(h.root, "aside");
    expect(Bun.spawnSync(["mv", installed, aside]).exitCode).toBe(0);
    await mkdir(path.join(h.root, "test-releases"), { recursive: true });
    const impostor = path.join(h.root, "test-releases", previous);
    expect(
      Bun.spawnSync(["cp", "-a", h.bundle101.tree, impostor]).exitCode,
    ).toBe(0);
    try {
      const rolled = await ControlClient.update(h.socket, "rollback");
      expect(rolled?.ok).toBe(false);
      if (rolled && !rolled.ok) {
        expect(rolled.error.kind).toBe("update-failed");
        expect(rolled.error.message).toContain("not installed");
      }
      expect(await h.active()).toBe(running);
    } finally {
      await rm(impostor, { recursive: true, force: true });
      expect(Bun.spawnSync(["mv", aside, installed]).exitCode).toBe(0);
    }
    expect(await h.health()).toBe(200);
  }, 120_000);
  test("after a crash an installed release is verified again before it restarts, and one changed meanwhile falls back to the built-in release", async () => {
    const running = await h.active();
    if (!running || running === "built-in")
      throw new Error("No installed release runs.");
    const verified = () => h.log.split(`verified ${running} in`).length - 1;
    const pidOf = async () => (await h.status()).active?.pid ?? 0;
    const first = await pidOf();
    const before = verified();
    process.kill(first, "SIGKILL");
    const second = await h.waitFor("the restart after the crash", async () => {
      const pid = await pidOf();
      return pid && pid !== first ? pid : null;
    });
    expect(verified()).toBeGreaterThan(before);
    // Changed while it runs, then crashed: the restart refuses it until it is whole again.
    const file = path.join(
      h.root,
      "store/releases",
      running,
      "apps/web/server/start.ts",
    );
    const original = await Bun.file(file).text();
    await Bun.write(file, `${original}\n// changed\n`);
    process.kill(second, "SIGKILL");
    await h.waitFor("the changed release to be refused", async () =>
      h.log.includes(`did not start ${running}`) ? true : null,
    );
    // Not retried forever: the built-in release serves instead.
    await h.waitFor("the built-in release to serve", async () =>
      (await h.active()) === "built-in" ? true : null,
    );
    expect(await h.health()).toBe(200);
    // Whole again, it is handed back to, verified, by name.
    await Bun.write(file, original);
    expect((await ControlClient.handover(h.socket, running))?.ok).toBe(true);
    expect(await h.active()).toBe(running);
    expect(await h.health()).toBe(200);
  }, 120_000);
});
