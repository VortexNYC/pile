import { z } from "zod";

import { safeJSON } from "../global/team-metadata.js";

export const slackIngestionModeSchema = z.enum([
  "manual",
  "one_to_one",
  "time_based",
  "ai",
]);

export type SlackIngestionMode = z.infer<typeof slackIngestionModeSchema>;

export const slackIngestionConfigSchema = z
  .object({
    ingestionMode: slackIngestionModeSchema.default("one_to_one"),
  })
  .passthrough();

export function getSlackIngestionMode(raw: string): SlackIngestionMode {
  const parsed = safeJSON(raw);
  const result = slackIngestionConfigSchema.safeParse(parsed);
  if (!result.success) {
    return "one_to_one";
  }
  return result.data.ingestionMode;
}
