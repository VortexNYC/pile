import {
  and,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  not,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import { workspaceIssues } from "./schema.js";

export const filterFieldSchema = z.enum([
  "status",
  "priority",
  "assigneeId",
  "projectId",
  "cycleId",
  "labelIds",
  "createdAt",
  "updatedAt",
  "title",
  "description",
  "identifier",
]);

export type FilterField = z.infer<typeof filterFieldSchema>;

const eqFilterSchema = z.object({
  op: z.literal("eq"),
  field: filterFieldSchema,
  value: z.string().nullable(),
});

const neFilterSchema = z.object({
  op: z.literal("ne"),
  field: filterFieldSchema,
  value: z.string().nullable(),
});

const gtFilterSchema = z.object({
  op: z.literal("gt"),
  field: filterFieldSchema,
  value: z.string(),
});

const gteFilterSchema = z.object({
  op: z.literal("gte"),
  field: filterFieldSchema,
  value: z.string(),
});

const ltFilterSchema = z.object({
  op: z.literal("lt"),
  field: filterFieldSchema,
  value: z.string(),
});

const lteFilterSchema = z.object({
  op: z.literal("lte"),
  field: filterFieldSchema,
  value: z.string(),
});

const inFilterSchema = z.object({
  op: z.literal("in"),
  field: filterFieldSchema,
  values: z.array(z.string()),
});

const notInFilterSchema = z.object({
  op: z.literal("notIn"),
  field: filterFieldSchema,
  values: z.array(z.string()),
});

const containsFilterSchema = z.object({
  op: z.literal("contains"),
  field: filterFieldSchema,
  value: z.string(),
});

export type FilterCondition =
  | z.infer<typeof eqFilterSchema>
  | z.infer<typeof neFilterSchema>
  | z.infer<typeof gtFilterSchema>
  | z.infer<typeof gteFilterSchema>
  | z.infer<typeof ltFilterSchema>
  | z.infer<typeof lteFilterSchema>
  | z.infer<typeof inFilterSchema>
  | z.infer<typeof notInFilterSchema>
  | z.infer<typeof containsFilterSchema>
  | { op: "and"; filters: FilterCondition[] }
  | { op: "or"; filters: FilterCondition[] }
  | { op: "not"; filter: FilterCondition };

const andFilterSchema: z.ZodType<{ op: "and"; filters: FilterCondition[] }> =
  z.object({
    op: z.literal("and"),
    filters: z.lazy(() => filterConditionSchema.array()),
  });

const orFilterSchema: z.ZodType<{ op: "or"; filters: FilterCondition[] }> =
  z.object({
    op: z.literal("or"),
    filters: z.lazy(() => filterConditionSchema.array()),
  });

const notFilterSchema: z.ZodType<{ op: "not"; filter: FilterCondition }> =
  z.object({
    op: z.literal("not"),
    filter: z.lazy(() => filterConditionSchema),
  });

export const filterConditionSchema: z.ZodType<FilterCondition> = z.union([
  eqFilterSchema,
  neFilterSchema,
  gtFilterSchema,
  gteFilterSchema,
  ltFilterSchema,
  lteFilterSchema,
  inFilterSchema,
  notInFilterSchema,
  containsFilterSchema,
  andFilterSchema,
  orFilterSchema,
  notFilterSchema,
]);

const columnByField = {
  status: workspaceIssues.status,
  priority: workspaceIssues.priority,
  assigneeId: workspaceIssues.assigneeId,
  projectId: workspaceIssues.projectId,
  cycleId: workspaceIssues.cycleId,
  labelIds: workspaceIssues.labelIds,
  createdAt: workspaceIssues.createdAt,
  updatedAt: workspaceIssues.updatedAt,
  title: workspaceIssues.title,
  description: workspaceIssues.description,
  identifier: workspaceIssues.identifier,
} as const;

function fieldColumn(field: FilterField) {
  return columnByField[field];
}

export function filterToSql(filter: FilterCondition): SQL<unknown> {
  switch (filter.op) {
    case "eq": {
      const column = fieldColumn(filter.field);
      return filter.value === null ? isNull(column) : eq(column, filter.value);
    }
    case "ne": {
      const column = fieldColumn(filter.field);
      return filter.value === null
        ? isNotNull(column)
        : ne(column, filter.value);
    }
    case "gt":
      return gt(fieldColumn(filter.field), filter.value);
    case "gte":
      return gte(fieldColumn(filter.field), filter.value);
    case "lt":
      return lt(fieldColumn(filter.field), filter.value);
    case "lte":
      return lte(fieldColumn(filter.field), filter.value);
    case "in":
      return inArray(fieldColumn(filter.field), filter.values);
    case "notIn":
      return notInArray(fieldColumn(filter.field), filter.values);
    case "contains": {
      const column = fieldColumn(filter.field);
      if (filter.field === "labelIds") {
        return like(
          sql`',' || COALESCE(${column}, '') || ','`,
          `%,${filter.value},%`
        );
      }
      return like(column, `%${filter.value}%`);
    }
    case "and": {
      const parts = filter.filters.map(filterToSql).filter(Boolean);
      return parts.length === 0 ? sql`1` : and(...parts)!;
    }
    case "or": {
      const parts = filter.filters.map(filterToSql).filter(Boolean);
      return parts.length === 0 ? sql`0` : or(...parts)!;
    }
    case "not":
      return not(filterToSql(filter.filter));
    default: {
      const neverFilter: never = filter;
      throw new Error(`Unsupported filter op: ${String(neverFilter)}`);
    }
  }
}
