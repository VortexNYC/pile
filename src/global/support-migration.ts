import { z } from "zod";

import {
  intercomSupportCredentialsSchema,
  intercomSupportOptionsSchema,
  jamMcpSupportCredentialsSchema,
  jamMcpSupportOptionsSchema,
  jamSupportCredentialsSchema,
  jamSupportOptionsSchema,
  plainSupportCredentialsSchema,
  plainSupportOptionsSchema,
  zendeskSupportCredentialsSchema,
  zendeskSupportOptionsSchema,
} from "../support-migration/index.js";

export const supportMigrationRunBodySchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("intercom"),
    credentials: intercomSupportCredentialsSchema,
    options: intercomSupportOptionsSchema.optional(),
  }),
  z.object({
    source: z.literal("jam"),
    credentials: jamSupportCredentialsSchema,
    options: jamSupportOptionsSchema.optional(),
  }),
  z.object({
    source: z.literal("jam-mcp"),
    credentials: jamMcpSupportCredentialsSchema,
    options: jamMcpSupportOptionsSchema.optional(),
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

export const supportMigrationValidateBodySchema = z.discriminatedUnion(
  "source",
  [
    z.object({
      source: z.literal("intercom"),
      credentials: intercomSupportCredentialsSchema,
    }),
    z.object({
      source: z.literal("jam"),
      credentials: jamSupportCredentialsSchema,
    }),
    z.object({
      source: z.literal("jam-mcp"),
      credentials: jamMcpSupportCredentialsSchema,
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
