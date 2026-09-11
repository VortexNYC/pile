import { z } from "zod";

import {
  intercomSupportCredentialsSchema,
  intercomSupportOptionsSchema,
  plainSupportCredentialsSchema,
  plainSupportOptionsSchema,
  zendeskSupportCredentialsSchema,
  zendeskSupportOptionsSchema,
} from "../support-migration/index.js";

export const supportMigrationSourceSchema = z.enum([
  "intercom",
  "plain",
  "zendesk",
]);

export const supportMigrationSourceNames = [
  "intercom",
  "plain",
  "zendesk",
] as const;

export const supportMigrationRunBodySchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("intercom"),
    credentials: intercomSupportCredentialsSchema,
    options: intercomSupportOptionsSchema.optional(),
  }),
  z.object({
    source: z.literal("plain"),
    credentials: plainSupportCredentialsSchema,
    options: plainSupportOptionsSchema.optional(),
  }),
  z.object({
    source: z.literal("zendesk"),
    credentials: zendeskSupportCredentialsSchema,
    options: zendeskSupportOptionsSchema.optional(),
  }),
]);

export type SupportMigrationRunBody = z.infer<
  typeof supportMigrationRunBodySchema
>;

export const supportMigrationValidateBodySchema = z.discriminatedUnion(
  "source",
  [
    z.object({
      source: z.literal("intercom"),
      credentials: intercomSupportCredentialsSchema,
    }),
    z.object({
      source: z.literal("plain"),
      credentials: plainSupportCredentialsSchema,
    }),
    z.object({
      source: z.literal("zendesk"),
      credentials: zendeskSupportCredentialsSchema,
    }),
  ]
);

export type SupportMigrationValidateBody = z.infer<
  typeof supportMigrationValidateBodySchema
>;
