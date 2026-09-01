import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.js";

export function createD1(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type D1Client = ReturnType<typeof createD1>;
