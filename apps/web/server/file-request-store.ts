import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { FileRequestStore } from "@nimbus/api/file-request";
import type { Database } from "./db";
import { atOrUnder, relocated } from "./db/path-prefix";
import { fileRequestUploads, fileRequests } from "./db/schema";

const counted = (activeSince: number) =>
  sql`(${fileRequestUploads.finishedAt} IS NOT NULL OR ${fileRequestUploads.createdAt} >= ${activeSince})`;

export function createFileRequestStore(database: Database): FileRequestStore {
  const usage = async (requestId: string, activeSince: number) => {
    const [row] = await database
      .select({
        files: sql<number>`count(*)`,
        bytes: sql<number>`coalesce(sum(${fileRequestUploads.size}), 0)`,
      })
      .from(fileRequestUploads)
      .where(
        and(eq(fileRequestUploads.requestId, requestId), counted(activeSince)),
      );
    return { files: Number(row?.files ?? 0), bytes: Number(row?.bytes ?? 0) };
  };
  return {
    async create(request) {
      await database.insert(fileRequests).values(request);
    },
    async getByToken(token) {
      const [row] = await database
        .select()
        .from(fileRequests)
        .where(eq(fileRequests.token, token));
      return row ?? null;
    },
    async getById(id) {
      const [row] = await database
        .select()
        .from(fileRequests)
        .where(eq(fileRequests.id, id));
      return row ?? null;
    },
    async list(userId) {
      const rows = await database
        .select({
          request: fileRequests,
          files: sql<number>`count(${fileRequestUploads.id})`,
          bytes: sql<number>`coalesce(sum(${fileRequestUploads.size}), 0)`,
        })
        .from(fileRequests)
        .leftJoin(
          fileRequestUploads,
          and(
            eq(fileRequestUploads.requestId, fileRequests.id),
            sql`${fileRequestUploads.finishedAt} IS NOT NULL`,
          ),
        )
        .where(eq(fileRequests.createdBy, userId))
        .groupBy(fileRequests.id)
        .orderBy(fileRequests.createdAt);
      return rows.map((row) => ({
        ...row.request,
        received: { files: Number(row.files), bytes: Number(row.bytes) },
      }));
    },
    async update(id, userId, settings) {
      const [row] = await database
        .update(fileRequests)
        .set(settings)
        .where(and(eq(fileRequests.id, id), eq(fileRequests.createdBy, userId)))
        .returning();
      return row ?? null;
    },
    async revoke(id, userId) {
      await database
        .delete(fileRequests)
        .where(
          and(eq(fileRequests.id, id), eq(fileRequests.createdBy, userId)),
        );
    },
    async reserve(upload, { activeSince, maxActive }) {
      const u = fileRequestUploads;
      // One statement, so concurrent uploads cannot both pass a limit check.
      const inserted = database.all<{ id: string }>(sql`
        INSERT INTO ${u} (id, request_id, uploader_hash, size, created_at)
        SELECT ${upload.id}, r.id, ${upload.uploaderHash}, ${upload.size}, ${upload.createdAt}
        FROM ${fileRequests} r
        WHERE r.id = ${upload.requestId}
          AND (SELECT count(*) FROM ${u} WHERE request_id = r.id AND finished_at IS NULL AND created_at >= ${activeSince}) < ${maxActive}
          AND (r.max_files IS NULL OR (SELECT count(*) FROM ${u} WHERE request_id = r.id AND ${counted(activeSince)}) < r.max_files)
          AND (r.max_total_bytes IS NULL OR (SELECT coalesce(sum(size), 0) FROM ${u} WHERE request_id = r.id AND ${counted(activeSince)}) + ${upload.size} <= r.max_total_bytes)
        RETURNING id`);
      if (inserted.length) return { kind: "reserved" };
      const [request] = await database
        .select()
        .from(fileRequests)
        .where(eq(fileRequests.id, upload.requestId));
      if (!request) return { kind: "unavailable" };
      const used = await usage(upload.requestId, activeSince);
      if (request.maxFiles !== null && used.files >= request.maxFiles)
        return { kind: "file-limit" };
      if (
        request.maxTotalBytes !== null &&
        used.bytes + upload.size > request.maxTotalBytes
      )
        return { kind: "byte-limit" };
      return { kind: "busy" };
    },
    usage,
    async getUpload(id) {
      const [row] = await database
        .select({
          id: fileRequestUploads.id,
          requestId: fileRequestUploads.requestId,
          uploaderHash: fileRequestUploads.uploaderHash,
          size: fileRequestUploads.size,
          createdAt: fileRequestUploads.createdAt,
        })
        .from(fileRequestUploads)
        .where(eq(fileRequestUploads.id, id));
      return row ?? null;
    },
    async finishUpload(id, name, finishedAt) {
      await database
        .update(fileRequestUploads)
        .set({ name, finishedAt })
        .where(
          and(
            eq(fileRequestUploads.id, id),
            isNull(fileRequestUploads.finishedAt),
          ),
        );
    },
    async releaseUpload(id) {
      await database
        .delete(fileRequestUploads)
        .where(
          and(
            eq(fileRequestUploads.id, id),
            isNull(fileRequestUploads.finishedAt),
          ),
        );
    },
    async releaseAbandoned(cutoff) {
      await database
        .delete(fileRequestUploads)
        .where(
          and(
            isNull(fileRequestUploads.finishedAt),
            lt(fileRequestUploads.createdAt, cutoff),
          ),
        );
    },
  };
}

/** A synchronous drive store transaction; see drive-store.ts. */
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const detachedSchema = z.object({
  requests: z.array(
    z.object({
      id: z.string(),
      token: z.string(),
      path: z.string(),
      createdBy: z.string(),
      createdAt: z.number(),
      expiresAt: z.number().nullable(),
      passwordHash: z.string().nullable(),
      note: z.string().nullable(),
      maxFileBytes: z.number().nullable(),
      maxFiles: z.number().nullable(),
      maxTotalBytes: z.number().nullable(),
    }),
  ),
  uploads: z.array(
    z.object({
      id: z.string(),
      requestId: z.string(),
      uploaderHash: z.string(),
      size: z.number(),
      createdAt: z.number(),
      finishedAt: z.number().nullable(),
      name: z.string().nullable(),
    }),
  ),
});
/** File requests suspended while their folder is in trash, with their upload ledger. */
export type DetachedFileRequests = z.infer<typeof detachedSchema>;

/**
 * File request links follow their folder by the same rules as public links:
 * rewritten on rename and move, suspended with the trash record, restored with
 * it, and discarded on permanent deletion. Each function runs inside the
 * caller's transaction, so it joins the drive store's own record changes.
 */
export const FileRequestRecords = {
  empty: { requests: [], uploads: [] } satisfies DetachedFileRequests,
  /** The shape of suspended records inside a trash row. */
  schema: detachedSchema,
  /** Validate suspended records read back from a trash row. */
  parse: (value: unknown) => detachedSchema.parse(value),
  /** Delete and return the requests at or under `path`, with their uploads. */
  detach(tx: Transaction, path: string): DetachedFileRequests {
    const requests = tx
      .select()
      .from(fileRequests)
      .where(atOrUnder(fileRequests.path, path))
      .all();
    const ids = requests.map((row) => row.id);
    const uploads = ids.length
      ? tx
          .select()
          .from(fileRequestUploads)
          .where(inArray(fileRequestUploads.requestId, ids))
          .all()
      : [];
    if (ids.length) {
      tx.delete(fileRequestUploads)
        .where(inArray(fileRequestUploads.requestId, ids))
        .run();
      tx.delete(fileRequests).where(inArray(fileRequests.id, ids)).run();
    }
    return { requests, uploads };
  },
  /** Reinsert suspended records, except those of accounts removed meanwhile. */
  reattach(
    tx: Transaction,
    detached: DetachedFileRequests,
    liveUserIds: ReadonlySet<string>,
  ) {
    const requests = detached.requests.filter((row) =>
      liveUserIds.has(row.createdBy),
    );
    const restored = new Set(requests.map((row) => row.id));
    const uploads = detached.uploads.filter((row) =>
      restored.has(row.requestId),
    );
    if (requests.length) tx.insert(fileRequests).values(requests).run();
    if (uploads.length) tx.insert(fileRequestUploads).values(uploads).run();
  },
  /** Rewrite the paths at or under `from` to the same place under `to`. */
  relocate(tx: Transaction, from: string, to: string) {
    tx.update(fileRequests)
      .set({ path: relocated(fileRequests.path, from, to) })
      .where(atOrUnder(fileRequests.path, from))
      .run();
  },
} as const;
