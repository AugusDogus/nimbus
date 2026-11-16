import { or, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

/**
 * Match a drive path and its descendants. Every descendant of `a/b` sorts in
 * [`a/b/`, `a/b0`) because "0" follows "/" in byte order, so the match is two
 * range comparisons SQLite answers from an index on the column, and SQL
 * wildcard characters in names stay literal.
 */
export function atOrUnder(column: SQLiteColumn, path: string): SQL {
  if (!path)
    throw new Error(
      "Nimbus refused to rewrite records for the drive root. The root cannot be moved or trashed; no records were changed.",
    );
  return (
    or(
      sql`${column} = ${path}`,
      sql`(${column} >= ${`${path}/`} AND ${column} < ${`${path}0`})`,
    ) ?? sql`0`
  );
}

/** Rewrite a path column from `from` to `to` for rows at or under `from`. */
export const relocated = (column: SQLiteColumn, from: string, to: string) =>
  sql`${to} || substr(${column}, length(${from}) + 1)`;
