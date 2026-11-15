import { Server } from "@tus/server";
import { TRPCError } from "@trpc/server";
import type { Access } from "@nimbus/api/access";
import { requireExisting, safePath } from "@nimbus/api/file-operations";
import type { UploadStore } from "@/server/upload-store";
import { commitUpload, UploadMetadata } from "./upload-commit";

/** tus reports a key sent without a value, such as an empty folder, as null. Treat it as absent. */
const present = (metadata: Record<string, string | null> | undefined) =>
  Object.fromEntries(Object.entries(metadata ?? {}).filter((entry) => entry[1] !== null));

/** The error shape tus hooks throw to answer with a status and message. */
export type TusFailure = { status_code: number; body: string };

/**
 * The tus server for signed-in uploads. `access` resolves the requesting user; `fail` maps
 * errors to tus responses. Both are parameters so the hooks can be tested without a session.
 */
export function createUploadServer({
  store,
  access,
  fail,
}: {
  store: UploadStore;
  access: (request: Request) => Promise<Access>;
  fail: (error: unknown) => TusFailure;
}) {
  const finishes = new Map<string, Promise<void>>();
  // One commit per upload at a time: PATCH completion and HEAD recovery can race.
  const finish = async (request: Request, id: string, metadata: Record<string, string | null> | undefined) => {
    const pending = finishes.get(id);
    if (pending) return pending;
    const task = (async () => {
      const parsed = UploadMetadata.safeParse(present(metadata));
      if (!parsed.success)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This upload's stored details are invalid. Start a new upload.",
        });
      await commitUpload(store, id, parsed.data, () => access(request));
    })();
    finishes.set(id, task);
    try {
      await task;
    } finally {
      finishes.delete(id);
    }
  };

  return new Server({
    path: "/api/upload",
    datastore: store,
    relativeLocation: true,
    async onIncomingRequest(request, id) {
      try {
        const current = await access(request);
        if (request.method === "POST" || request.method === "OPTIONS" || !id) return;
        if (!/^[a-f0-9]{32}$/.test(id))
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "This upload identifier is invalid. Start a new upload.",
          });
        const upload = await store.getUpload(id);
        if (upload.metadata?.owner !== current.user.id)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "This upload belongs to another user.",
          });
        const target = await safePath(upload.metadata?.targetPath ?? "");
        current.require(target.relative, "write");
        // A fully received upload whose publish failed would otherwise look finished to a resuming
        // client, which would then report success for a file that is not in the drive. Publish it
        // now, or fail so the client retries.
        if (request.method === "HEAD" && upload.size !== undefined && upload.offset === upload.size && !(await store.isFinished(id)))
          await finish(request, id, upload.metadata);
      } catch (error) {
        throw fail(error);
      }
    },
    async onUploadCreate(request, upload) {
      try {
        const current = await access(request);
        const metadata = UploadMetadata.safeParse({ ...present(upload.metadata), owner: current.user.id });
        if (!metadata.success)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Choose file and folder names without slashes or reserved names, then upload again.",
          });
        const target = await safePath(metadata.data.targetPath);
        current.require(target.relative, "write");
        const parent = await requireExisting(target.relative);
        if (!parent.stats.isDirectory())
          throw new TRPCError({ code: "BAD_REQUEST", message: "Upload destination must be a folder." });
        return {
          metadata: {
            filename: metadata.data.filename,
            targetPath: target.relative,
            folder: metadata.data.folder,
            conflict: metadata.data.conflict,
            owner: current.user.id,
          },
        };
      } catch (error) {
        throw fail(error);
      }
    },
    async onUploadFinish(request, upload) {
      try {
        await finish(request, upload.id, upload.metadata);
      } catch (error) {
        throw fail(error);
      }
      return {};
    },
  });
}
