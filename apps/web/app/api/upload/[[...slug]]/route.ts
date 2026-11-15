import { Server } from "@tus/server";
import { z } from "zod";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import { getDataRoot } from "@nimbus/api/data-root";
import { requireExisting, safePath } from "@nimbus/api/file-operations";
import { httpError, requestAccess } from "@/server/http-files";
import { UploadStore } from "@/server/upload-store";
import { commitUpload, UploadMetadata } from "../upload-commit";

const tusFailureSchema = z.object({
  status_code: z.number().int().min(400).max(599),
  body: z.string(),
});
function tusFailure(error: unknown) {
  const failure = tusFailureSchema.safeParse(error);
  if (failure.success) return failure.data;
  const response = httpError(error);
  return {
    status_code: response.status,
    body:
      error instanceof Error ? error.message : "The upload failed. Try again.",
  };
}

let server: Server | undefined;

async function getServer() {
  if (server) return server;
  const uploadsDir = path.join(getDataRoot(), ".nimbus", "uploads");
  await mkdir(uploadsDir, { recursive: true });
  const store = new UploadStore({
    directory: uploadsDir,
    expirationPeriodInMilliseconds: 24 * 60 * 60 * 1000,
  });
  const finishes = new Map<string, Promise<void>>();
  server = new Server({
    path: "/api/upload",
    datastore: store,
    relativeLocation: true,
    async onIncomingRequest(request, id) {
      try {
        const access = await requestAccess(request);
        if (request.method !== "POST" && request.method !== "OPTIONS" && id) {
          if (!/^[a-f0-9]{32}$/.test(id))
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "This upload identifier is invalid. Start a new upload.",
            });
          const upload = await store.getUpload(id);
          if (upload.metadata?.owner !== access.user.id)
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "This upload belongs to another user.",
            });
          const target = await safePath(upload.metadata?.targetPath ?? "");
          access.require(target.relative, "write");
        }
      } catch (error) {
        throw tusFailure(error);
      }
    },
    async onUploadCreate(request, upload) {
      try {
        const access = await requestAccess(request);
        const metadata = UploadMetadata.safeParse({
          ...upload.metadata,
          owner: access.user.id,
        });
        if (!metadata.success)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Choose file and folder names without slashes or reserved names, then upload again.",
          });
        const target = await safePath(metadata.data.targetPath);
        access.require(target.relative, "write");
        const parent = await requireExisting(target.relative);
        if (!parent.stats.isDirectory())
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Upload destination must be a folder.",
          });
        return {
          metadata: {
            filename: metadata.data.filename,
            targetPath: target.relative,
            folder: metadata.data.folder,
            conflict: metadata.data.conflict,
            owner: access.user.id,
          },
        };
      } catch (error) {
        throw tusFailure(error);
      }
    },
    async onUploadFinish(request, upload) {
      const existing = finishes.get(upload.id);
      if (existing) {
        try {
          await existing;
        } catch (error) {
          throw tusFailure(error);
        }
        return {};
      }
      const task = (async () => {
        const metadata = UploadMetadata.safeParse(upload.metadata);
        if (!metadata.success)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "This upload's stored details are invalid. Start a new upload.",
          });
        await commitUpload(store, upload.id, metadata.data, () =>
          requestAccess(request),
        );
      })();
      finishes.set(upload.id, task);
      try {
        await task;
      } catch (error) {
        throw tusFailure(error);
      } finally {
        finishes.delete(upload.id);
      }
      return {};
    },
  });
  return server;
}

async function handler(request: Request) {
  try {
    return await (await getServer()).handleWeb(request);
  } catch (error) {
    return httpError(error);
  }
}
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;
