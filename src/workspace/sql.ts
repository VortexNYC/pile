import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/** DO SQLite caps bound variables per statement at ~100 — one `?` per id
 *  in `IN (?, ?, …)` overflows on full-page id sets (a 99-issue list 500'd
 *  on PILE-448). `json_each` binds the whole set as a single array
 *  parameter instead, so any size stays under the cap. */
export function inArrayJson(
  column: SQLWrapper,
  values: readonly string[]
): SQL {
  return sql`${column} in (select value from json_each(${JSON.stringify(values)}))`;
}

/** `NOT IN` twin of {@link inArrayJson} — same single-param trick. */
export function notInArrayJson(
  column: SQLWrapper,
  values: readonly string[]
): SQL {
  return sql`${column} not in (select value from json_each(${JSON.stringify(values)}))`;
}
