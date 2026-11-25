import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import path from "node:path";
import type { ReleaseManifest as Manifest } from "../updates/release-manifest";
import { ReleaseSignature } from "../updates/release-signature";
import { ReleaseStore } from "../updates/release-store";
import { ControlClient } from "./control-client";
import { UpdatesHarness, built } from "./updates-e2e-harness";

/**
 * In-app updates with real processes (see docs/updates.md), what is refused: a manifest changed
 * after signing, a bundle cut short, one needing a newer image and one whose server never gets
 * ready, each leaving the running release serving; a damaged installed release at boot; and one
 * whose key is no longer trusted. Needs the built client. Its setup builds build 101 (about 15 seconds), makes 102 from
 * it, and installs both, so an installed release runs and another ran before it.
 */
const h = new UpdatesHarness();

describe.skipIf(!built)("in-app updates with real processes: refusals", () => {
  beforeAll(
    () =>
      h.setUp({
        // Placed in the store before the supervisor starts, as installs leave them, without the
        // two handovers installing them would cost: 102 runs, 101 ran before it.
        prepare: async () => {
          const earlier = await h.place({
            manifest: h.bundle101.manifest,
            bytes: new Uint8Array(
              await Bun.file(h.bundle101.archive).arrayBuffer(),
            ),
          });
          // Below the builds the refusals publish (103, 104), so the watermark still offers them.
          const later = await h.place(await h.variant(102, h.bundle101.tree));
          await ReleaseStore.write(path.join(h.root, "store/releases"), {
            ...ReleaseStore.empty(),
            current: later,
            previous: earlier,
            watermarks: { "example/nimbus edge": 102 },
          });
        },
      }),
    240_000,
  );

  test("an installed release placed before the start is the one that runs", async () => {
    expect(await h.active()).toMatch(/^edge-102-/);
  });
  // A drain of at most NIMBUS_STOP_SECONDS, a sweep, and removing the release trees.
  afterAll(() => h.tearDown(), 60_000);

  test("a manifest changed after signing, a bundle cut short, one needing a newer image and one never ready each leave the running release serving", async () => {
    const running = await h.active();

    // Changed after signing: the check refuses it.
    const later = await h.variant(103, h.bundle101.tree);
    await h.publish(later.manifest, later.bytes);
    const changed = h.published.get("manifest.json");
    if (!changed) throw new Error("nothing published");
    h.published.set(
      "manifest.json",
      new TextEncoder().encode(
        new TextDecoder()
          .decode(changed)
          .replace('"sequence": 103', '"sequence": 109'),
      ),
    );
    const tampered = await ControlClient.checkForUpdate(h.socket);
    expect(tampered.status).toBe(503);
    expect(JSON.stringify(await tampered.json())).toContain(
      "does not match its manifest",
    );
    expect(await h.active()).toBe(running);

    // Cut short in transit: the install refuses it before unpacking anything.
    await h.publish(
      later.manifest,
      later.bytes.slice(0, Math.floor(later.bytes.byteLength / 2)),
    );
    expect((await ControlClient.checkForUpdate(h.socket)).status).toBe(200);
    const cut = await ControlClient.update(h.socket, "install");
    expect(cut?.ok).toBe(false);
    if (cut && !cut.ok)
      expect(cut.error.message).toContain("cut short or changed");
    expect(await h.active()).toBe(running);
    expect(await h.health()).toBe(200);

    // Needs a newer image: reported, never installed.
    const needsImage: Manifest = {
      ...later.manifest,
      requires: { ...later.manifest.requires, bun: "9.9.9" },
    };
    await h.publish(needsImage, later.bytes);
    const reported = await ControlClient.checkForUpdate(h.socket);
    expect(JSON.stringify(await reported.json())).toContain(
      "needs-newer-image",
    );
    const refused = await ControlClient.update(h.socket, "install");
    expect(refused?.ok).toBe(false);
    if (refused && !refused.ok)
      expect(refused.error.message).toContain(
        "Pull ghcr.io/example/nimbus:edge",
      );
    expect(await h.active()).toBe(running);

    // Installs, but its server never gets ready: abandoned, and the running release serves on.
    const broken = await h.variant(104, h.bundle101.tree, async (copy) => {
      await Bun.write(
        path.join(copy, "apps/web/server/start.ts"),
        'process.on("disconnect", () => process.exit(0));\nprocess.on("message", () => process.exit(0));\nsetInterval(() => undefined, 1000);\n',
      );
    });
    await h.publish(broken.manifest, broken.bytes);
    expect((await ControlClient.checkForUpdate(h.socket)).status).toBe(200);
    const never = await ControlClient.update(h.socket, "install");
    expect(never?.ok).toBe(false);
    if (never && !never.ok) expect(never.error.kind).toBe("not-ready");
    expect(await h.active()).toBe(running);
    expect(await h.health()).toBe(200);
  }, 180_000);

  test("a damaged installed release is not started: the supervisor falls back to the built-in one", async () => {
    const damaged = await h.active();
    if (!damaged || damaged === "built-in")
      throw new Error("No installed release runs.");
    h.supervisor?.kill("SIGTERM");
    expect(await h.supervisor?.exited).toBe(0);
    await Bun.write(
      path.join(h.root, "store/releases", damaged, "apps/web/server/start.ts"),
      "// replaced\n",
    );
    const started = performance.now();
    await h.startSupervisor();
    h.note(
      `(restart with a damaged release took ${Math.round(performance.now() - started)} ms)`,
    );
    expect(await h.active()).toBe("built-in");
    expect(h.log).toContain("not the tree its signed manifest describes");
    expect(await h.health()).toBe(200);
  }, 120_000);

  test("once its key is no longer trusted, an installed release is never started, a rollback included", async () => {
    h.supervisor?.kill("SIGTERM");
    expect(await h.supervisor?.exited).toBe(0);
    // The image now trusts another key only, as after rotating a compromised one.
    const rotated = await ReleaseSignature.generate("rotated-key");
    await Bun.write(
      path.join(h.root, "keys.json"),
      JSON.stringify({ keys: [rotated.trustEntry] }),
    );
    await chmod(path.join(h.root, "keys.json"), 0o644);
    await h.startSupervisor();
    expect(await h.active()).toBe("built-in");
    const rolled = await ControlClient.update(h.socket, "rollback");
    expect(rolled?.ok).toBe(false);
    // Refused for its signature before anything of it starts, not tried and abandoned.
    if (rolled && !rolled.ok) {
      expect(rolled.error.kind).toBe("update-failed");
      expect(rolled.error.message).toContain("does not trust");
    }
    expect(await h.active()).toBe("built-in");
    expect(await h.health()).toBe(200);
  }, 120_000);
});
