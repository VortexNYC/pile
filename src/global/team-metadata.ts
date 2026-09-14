import { z } from "zod";

export const teamMetadataSchema = z.object({
  key: z.string(),
  ownerId: z.string(),
  isDefault: z.boolean(),
  isPublic: z.boolean(),
  parentAutoClose: z.boolean(),
  subIssueAutoClose: z.boolean(),
  triageAssigneeId: z.string().nullable().optional(),
  defaultTemplateId: z.string().nullable().optional(),
  defaultRepo: z.string().nullable().optional(),
});

export type TeamMetadata = z.infer<typeof teamMetadataSchema>;

export function safeJSON(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function parseTeamMetadata(
  raw: string | null | undefined
): TeamMetadata | null {
  if (!raw) return null;
  const parsed = teamMetadataSchema.safeParse(safeJSON(raw));
  return parsed.success ? parsed.data : null;
}

export function teamMetadataString(values: {
  key: string;
  ownerId: string;
  isDefault: boolean;
  isPublic: boolean;
  parentAutoClose?: boolean;
  subIssueAutoClose?: boolean;
  triageAssigneeId?: string | null;
  defaultTemplateId?: string | null;
  defaultRepo?: string | null;
}): string {
  return JSON.stringify({
    key: values.key,
    ownerId: values.ownerId,
    isDefault: values.isDefault,
    isPublic: values.isPublic,
    parentAutoClose: values.parentAutoClose ?? false,
    subIssueAutoClose: values.subIssueAutoClose ?? false,
    triageAssigneeId: values.triageAssigneeId ?? null,
    defaultTemplateId: values.defaultTemplateId ?? null,
    defaultRepo: values.defaultRepo ?? null,
  });
}
