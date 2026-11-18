import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAccess } from "@nimbus/api/access";
import { commitStagedFile, stageFile } from "@nimbus/api/file-content";
import { copyItem } from "@nimbus/api/file-operations";
import { FileVersions } from "@nimbus/api/file-versions";
import { createTestDriveStore } from "@nimbus/api/testing";
import { cleanExpiredData } from "@/server/maintenance";
import { UploadStore } from "@/server/upload-store";
import { commitUpload, UploadMetadata } from "@/server/routes/upload-commit";

/**
 * A drive folder that is its own filesystem (a disk or share mounted inside the drive) cannot
 * be renamed into from the root's staging area. Mounting needs a mount namespace, so the outer
 * run re-runs this file inside `unshare` with a tmpfs mounted in a fresh data root.
 */
const nested = process.env.NIMBUS_TEST_NESTED_ROOT;
const unshare = Bun.which("unshare");

/**
 * Why this system cannot build the mounts, or null when it can. They need an unprivileged user
 * namespace, which some systems refuse: Ubuntu 24.04 restricts them through AppArmor, and
 * ci.yml lifts that restriction on its runner so this test runs there.
 */
function mountsUnavailable() {
  if (nested !== undefined) return null;
  if (unshare === null) return "unshare (util-linux) is not installed";
  const probe = Bun.spawnSync(
    [unshare, "--user", "--map-root-user", "--mount", "true"],
    { stdout: "ignore", stderr: "pipe" },
  );
  if (probe.exitCode === 0) return null;
  return `this system refuses unprivileged user namespaces: ${probe.stderr.toString().trim() || `unshare exited with ${probe.exitCode}`}`;
}
const unavailable = mountsUnavailable();
if (unavailable !== null)
  console.warn(`Skipping the nested mount tests: ${unavailable}.`);

if (nested === undefined)
  test.skipIf(unavailable !== null)(
    `writes into nested mounts and bind mounts keep versions, replace atomically and are cleaned up${unavailable === null ? "" : ` (skipped: ${unavailable})`}`,
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "nimbus-nested-"));
      try {
        for (const folder of ["mounted", "bound", "elsewhere"])
          await mkdir(path.join(root, folder));
        const run = Bun.spawn(
          [
            unshare ?? "unshare",
            "--user",
            "--map-root-user",
            "--mount",
            "sh",
            "-c",
            `mount -t tmpfs none "$0/mounted" && mount --bind "$0/elsewhere" "$0/bound" && exec "$1" test "$2"`,
            root,
            process.execPath,
            import.meta.path,
          ],
          {
            env: { ...process.env, NIMBUS_TEST_NESTED_ROOT: root },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [code, output] = await Promise.all([
          run.exited,
          new Response(run.stderr).text(),
        ]);
        expect({ code, output }).toMatchObject({ code: 0 });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    60_000,
  );
else
  describe("inside nested mounts", () => {
    const root = nested;
    const memory = createTestDriveStore();
    const store = new UploadStore({
      directory: path.join(root, ".nimbus/uploads"),
    });
    let next = 0;
    let previousRoot: string | undefined;

    beforeAll(async () => {
      previousRoot = process.env.NIMBUS_DATA_ROOT;
      process.env.NIMBUS_DATA_ROOT = root;
      await mkdir(store.directory, { recursive: true });
      expect((await stat(path.join(root, "mounted"))).dev).not.toBe(
        (await stat(root)).dev,
      );
      // A bind mount shares the root's device number, yet renames into it fail too.
      expect((await stat(path.join(root, "bound"))).dev).toBe(
        (await stat(root)).dev,
      );
    });
    afterAll(() => {
      if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
      else process.env.NIMBUS_DATA_ROOT = previousRoot;
    });

    // "mounted" is a tmpfs; "bound" is a bind mount of another folder of the root's filesystem.
    for (const folder of ["mounted", "bound"]) {
      const upload = async (
        body: string,
        filename: string,
        conflict: "replace" | "keep-both",
      ) => {
        const id = `upload-${next++}`;
        await writeFile(path.join(store.directory, id), body);
        return commitUpload(
          store,
          memory.store,
          id,
          UploadMetadata.parse({
            targetPath: folder,
            owner: "user-1",
            filename,
            conflict,
          }),
          () => getAccess(memory.store, "user-1"),
        );
      };

      test(`${folder}: an upload replacing a file keeps the old content as a version and never rewrites it in place`, async () => {
        const file = path.join(root, folder, "report.txt");
        await writeFile(file, "previous");
        const reader = await open(file, "r");
        try {
          expect(
            await upload("replacement", "report.txt", "replace"),
          ).toMatchObject({ kind: "published", replaced: true });
          expect(await readFile(file, "utf8")).toBe("replacement");
          // A reader of the old file still sees it whole: the new one took its place by rename.
          expect((await reader.readFile()).toString()).toBe("previous");
        } finally {
          await reader.close();
        }
        const [version] = await FileVersions.history(
          memory.store.versions,
          `${folder}/report.txt`,
        );
        expect(version).toMatchObject({ size: "previous".length });
      });

      test(`${folder}: an upload of a new file is published whole`, async () => {
        expect(await upload("fresh", "fresh.txt", "keep-both")).toMatchObject({
          kind: "published",
          path: `${folder}/fresh.txt`,
        });
        expect(
          await readFile(path.join(root, folder, "fresh.txt"), "utf8"),
        ).toBe("fresh");
      });

      test(`${folder}: WebDAV PUT writes and replaces files`, async () => {
        const relative = `${folder}/put.txt`;
        const put = async (body: string) => {
          const staged = await stageFile(body, path.join(root, relative));
          try {
            return await commitStagedFile(
              {
                userId: "user-1",
                drive: memory.store,
                authorize: () => getAccess(memory.store, "user-1"),
              },
              relative,
              staged,
              () => true,
            );
          } finally {
            await staged.discard();
          }
        };
        expect((await put("first")).kind).toBe("created");
        expect((await put("second")).kind).toBe("replaced");
        expect(await readFile(path.join(root, relative), "utf8")).toBe(
          "second",
        );
        expect(
          await FileVersions.history(memory.store.versions, relative),
        ).toHaveLength(1);
      });

      test(`${folder}: restoring a version of a file in the mount works`, async () => {
        const relative = `${folder}/restored.txt`;
        await writeFile(path.join(root, relative), "original");
        const put = async (body: string) => {
          const staged = await stageFile(body, path.join(root, relative));
          try {
            await commitStagedFile(
              {
                userId: "user-1",
                drive: memory.store,
                authorize: () => getAccess(memory.store, "user-1"),
              },
              relative,
              staged,
              () => true,
            );
          } finally {
            await staged.discard();
          }
        };
        await put("edited");
        const [version] = await FileVersions.history(
          memory.store.versions,
          relative,
        );
        if (!version) throw new Error("Saving did not keep a version.");
        expect(
          await FileVersions.restore({
            drive: memory.store,
            dataRoot: root,
            path: relative,
            id: version.id,
            archivedBy: "user-1",
          }),
        ).toMatchObject({ kind: "replaced" });
        expect(await readFile(path.join(root, relative), "utf8")).toBe(
          "original",
        );
      });

      test(`${folder}: COPY into the mount works`, async () => {
        await writeFile(path.join(root, "source.txt"), "copied");
        const access = await getAccess(memory.store, "user-1");
        await copyItem(
          memory.store,
          access,
          "source.txt",
          `${folder}/copy.txt`,
        );
        expect(
          await readFile(path.join(root, folder, "copy.txt"), "utf8"),
        ).toBe("copied");
      });

      test(`${folder}: maintenance removes abandoned staging files in the mount`, async () => {
        const staging = path.join(root, folder, ".nimbus", "uploads");
        await mkdir(staging, { recursive: true });
        const abandoned = path.join(staging, "abandoned.staged");
        await writeFile(abandoned, "left by a crash");
        const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
        await utimes(abandoned, old, old);
        await cleanExpiredData(
          memory.store,
          root,
          Date.now(),
          path.join(root, ".config"),
        );
        expect(existsSync(abandoned)).toBe(false);
      });
    }
  });
