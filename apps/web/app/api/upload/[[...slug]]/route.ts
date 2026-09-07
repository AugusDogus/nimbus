import { FileStore } from "@tus/file-store";
import { Server } from "@tus/server";
import { z } from "zod";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import { getDataRoot } from "@nimbus/api/data-root";
import { fileNameSchema } from "@nimbus/api/file-name";
import { publishFileEvent } from "@nimbus/api/file-events";
import { mutateFiles, requireUnlocked } from "@nimbus/api/file-mutations";
import {
  requireExisting,
  requireUnused,
  safePath,
} from "@nimbus/api/file-operations";
import { isApiError, isFsError } from "@nimbus/api/safe-path";
import { httpError, requestAccess } from "@/server/http-files";

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
  const store = new FileStore({
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
        const name = fileNameSchema.safeParse(upload.metadata?.filename);
        if (!name.success)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Choose a filename without slashes or reserved names.",
          });
        const target = await safePath(upload.metadata?.targetPath ?? "");
        access.require(target.relative, "write");
        const parent = await requireExisting(target.relative);
        if (!parent.stats.isDirectory())
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Upload destination must be a folder.",
          });
        return {
          metadata: {
            filename: name.data,
            targetPath: target.relative,
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
      const finish = async () => {
        const target = await safePath(upload.metadata?.targetPath ?? "");
        const access = await requestAccess(request);
        return mutateFiles([], { userId: access.user.id }, async () => {
          const currentAccess = await requestAccess(request);
          if (upload.metadata?.owner !== currentAccess.user.id)
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "This upload belongs to another user.",
            });
          const name = fileNameSchema.parse(upload.metadata?.filename);
          currentAccess.require(target.relative, "write");
          const parent = await requireExisting(target.relative);
          if (!parent.stats.isDirectory())
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Upload destination must be a folder.",
            });
          const marker = path.join(uploadsDir, `${upload.id}.done`);
          try {
            await readFile(marker);
            return;
          } catch (error) {
            if (!isFsError(error, "ENOENT")) throw error;
          }
          const ext = path.extname(name);
          const base = path.basename(name, ext);
          for (let index = 0; ; index++) {
            const candidate = index === 0 ? name : `${base} (${index})${ext}`;
            const destination = await safePath(
              [target.relative, candidate].filter(Boolean).join("/"),
            );
            currentAccess.require(destination.relative, "write");
            try {
              await requireUnused(destination.absolute);
            } catch (error) {
              if (isApiError(error, "CONFLICT")) continue;
              throw error;
            }
            requireUnlocked([destination.relative], {
              userId: currentAccess.user.id,
            });
            try {
              await copyFile(
                path.join(uploadsDir, upload.id),
                destination.absolute,
                constants.COPYFILE_EXCL,
              );
            } catch (error) {
              if (isFsError(error, "EEXIST")) continue;
              throw error;
            }
            await writeFile(marker, destination.relative);
            publishFileEvent({
              path: destination.absolute,
              event: "rename",
              ts: Date.now(),
            });
            return;
          }
        });
      };
      const task = finish();
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
