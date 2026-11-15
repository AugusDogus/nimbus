import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { FileRequestStore } from "@nimbus/api/file-request";
import type { db } from "./db";
import { fileRequestUploads, fileRequests } from "./db/schema";

const counted = (activeSince: number) =>
  sql`(${fileRequestUploads.finishedAt} IS NOT NULL OR ${fileRequestUploads.createdAt} >= ${activeSince})`;

export function createFileRequestStore(database: typeof db): FileRequestStore {
  const usage = async (requestId: string, activeSince: number) => {
    const [row] = await database
      .select({
        files: sql<number>`count(*)`,
        bytes: sql<number>`coalesce(sum(${fileRequestUploads.size}), 0)`,
      })
      .from(fileRequestUploads)
      .where(and(eq(fileRequestUploads.requestId, requestId), counted(activeSince)));
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
        .where(and(eq(fileRequests.id, id), eq(fileRequests.createdBy, userId)));
    },
    async reserve(upload, { activeSince, maxActive }) {
      const u = fileRequestUploads;
      // One statement, so concurrent uploads cannot both pass a limit check.
      const inserted = await database.all<{ id: string }>(sql`
        INSERT INTO ${u} (id, request_id, size, created_at)
        SELECT ${upload.id}, r.id, ${upload.size}, ${upload.createdAt}
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
        .where(and(eq(fileRequestUploads.id, id), isNull(fileRequestUploads.finishedAt)));
    },
    async releaseUpload(id) {
      await database
        .delete(fileRequestUploads)
        .where(and(eq(fileRequestUploads.id, id), isNull(fileRequestUploads.finishedAt)));
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
