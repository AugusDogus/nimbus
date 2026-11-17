import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAccess } from "@nimbus/api/access";
import { commitStagedFile, stageFile } from "@nimbus/api/file-content";
import { copyItem } from "@nimbus/api/file-operations";
import { FileVersions } from "@nimbus/api/file-versions";
import { createTestDriveStore } from "@nimbus/api/testing";
import { UploadStore } from "@/server/upload-store";
import { commitUpload, UploadMetadata } from "@/server/routes/upload-commit";

/**
 * A drive folder that is its own filesystem (a disk or share mounted inside the drive) cannot
 * be renamed into from the root's staging area. Mounting needs a mount namespace, so the outer
 * run re-runs this file inside `unshare` with a tmpfs mounted in a fresh data root.
 */
const nested = process.env.NIMBUS_TEST_NESTED_ROOT;
const unshare = Bun.which("unshare");

if (nested === undefined)
  test.skipIf(unshare === null)(
    "writes into a nested mount keep versions and replace atomically",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "nimbus-nested-"));
      try {
        await mkdir(path.join(root, "mounted"));
        const run = Bun.spawn(
          [
            unshare ?? "unshare",
            "--user",
            "--map-root-user",
            "--mount",
            "sh",
            "-c",
            `mount -t tmpfs none "$0/mounted" && exec "$1" test "$2"`,
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
  describe("inside a nested mount", () => {
    const root = nested;
    const memory = createTestDriveStore();
    const store = new UploadStore({
      directory: path.join(root, ".nimbus/uploads"),
    });
    let next = 0;
    const upload = async (
      body: string,
      filename: string,
      conflict: "replace" | "keep-both",
    ) => {
      const id = `upload-${next++}`;
      await writeFile(path.join(store.directory, id), body);
      return commitUpload(
        store,
        memory.store.versions,
        id,
        UploadMetadata.parse({
          targetPath: "mounted",
          owner: "user-1",
          filename,
          conflict,
        }),
        () => getAccess(memory.store, "user-1"),
      );
    };

    beforeAll(async () => {
      process.env.NIMBUS_DATA_ROOT = root;
      await mkdir(store.directory, { recursive: true });
      expect((await stat(path.join(root, "mounted"))).dev).not.toBe(
        (await stat(root)).dev,
      );
    });
    afterAll(() => {
      delete process.env.NIMBUS_DATA_ROOT;
    });

    test("an upload replacing a file keeps the old content as a version and never rewrites it in place", async () => {
      const file = path.join(root, "mounted/report.txt");
      await writeFile(file, "previous");
      const reader = await open(file, "r");
      try {
        expect(
          await upload("replacement", "report.txt", "replace"),
        ).toMatchObject({
          kind: "published",
          replaced: true,
        });
        expect(await readFile(file, "utf8")).toBe("replacement");
        // A reader of the old file still sees it whole: the new one took its place by rename.
        expect((await reader.readFile()).toString()).toBe("previous");
      } finally {
        await reader.close();
      }
      const [version] = await FileVersions.history(
        memory.store.versions,
        "mounted/report.txt",
      );
      expect(version).toMatchObject({ size: "previous".length });
    });

    test("an upload of a new file is published whole", async () => {
      expect(await upload("fresh", "fresh.txt", "keep-both")).toMatchObject({
        kind: "published",
        path: "mounted/fresh.txt",
      });
      expect(await readFile(path.join(root, "mounted/fresh.txt"), "utf8")).toBe(
        "fresh",
      );
    });

    test("WebDAV PUT writes and replaces files in the mount", async () => {
      const put = async (body: string) => {
        const staged = await stageFile(
          body,
          path.join(root, "mounted/put.txt"),
        );
        try {
          return await commitStagedFile(
            {
              userId: "user-1",
              versions: memory.store.versions,
              authorize: () => getAccess(memory.store, "user-1"),
            },
            "mounted/put.txt",
            staged,
            () => true,
          );
        } finally {
          await staged.discard();
        }
      };
      expect((await put("first")).kind).toBe("created");
      expect((await put("second")).kind).toBe("replaced");
      expect(await readFile(path.join(root, "mounted/put.txt"), "utf8")).toBe(
        "second",
      );
      expect(
        await FileVersions.history(memory.store.versions, "mounted/put.txt"),
      ).toHaveLength(1);
    });

    test("COPY into the mount works", async () => {
      await writeFile(path.join(root, "source.txt"), "copied");
      const access = await getAccess(memory.store, "user-1");
      await copyItem(memory.store, access, "source.txt", "mounted/copy.txt");
      expect(await readFile(path.join(root, "mounted/copy.txt"), "utf8")).toBe(
        "copied",
      );
    });
  });
