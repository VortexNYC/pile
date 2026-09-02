import { eq } from "drizzle-orm";
import type { D1Client } from "./db.js";
import { user } from "./schema.js";

export function findUserByEmail(db: D1Client, email: string) {
  return db.select().from(user).where(eq(user.email, email)).get();
}

export async function createUser(
  db: D1Client,
  values: {
    name: string;
    email: string;
    emailVerified?: boolean;
    image?: string | null;
  },
) {
  const id = crypto.randomUUID();
  const ts = new Date();
  await db.insert(user).values({
    id,
    name: values.name,
    email: values.email,
    emailVerified: values.emailVerified ?? false,
    image: values.image ?? null,
    createdAt: ts,
    updatedAt: ts,
  });
  return db.select().from(user).where(eq(user.id, id)).get();
}
