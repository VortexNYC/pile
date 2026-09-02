import type { SqlStorage } from "@cloudflare/workers-types";
import type { ZodTypeAny, z } from "zod";

export function execOne<T extends ZodTypeAny>(
  sql: SqlStorage,
  schema: T,
  query: string,
  ...params: unknown[]
): z.infer<T> | undefined {
  const cursor = sql.exec(query, ...params);
  const rows = Array.from(cursor);
  const first = rows[0];
  if (!first) return undefined;
  const parsed = schema.safeParse(first);
  return parsed.success ? parsed.data : undefined;
}

export function execAll<T extends ZodTypeAny>(
  sql: SqlStorage,
  schema: T,
  query: string,
  ...params: unknown[]
): z.infer<T>[] {
  const cursor = sql.exec(query, ...params);
  const rows = Array.from(cursor);
  const parsed = rows.map((row) => schema.safeParse(row));
  return parsed
    .filter((r): r is { success: true; data: z.infer<T> } => r.success)
    .map((r) => r.data);
}
