import {
  MAX_SERIALIZE_ARRAY_ITEMS,
  MAX_SERIALIZE_DEPTH,
  MAX_SERIALIZE_KEYS,
} from "../constants";
import type { Reporter } from "./sanitize";
import { getElementTarget, truncate } from "./sanitize";

type SerializerState = {
  seen: WeakMap<object, string>;
};

type SerializeValue = (
  value: unknown,
  state: SerializerState,
  depth: number,
  path: string
) => unknown;

const serializePrimitive = (
  value: unknown
): { handled: boolean; value?: unknown } => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return { handled: true, value };
  }
  if (typeof value === "string") {
    return { handled: true, value: truncate(value) };
  }
  if (typeof value === "undefined") {
    return { handled: true, value: "[undefined]" };
  }
  if (typeof value === "bigint") {
    return { handled: true, value: `${value.toString()}n` };
  }
  if (typeof value === "symbol") {
    return { handled: true, value: value.toString() };
  }
  if (typeof value === "function") {
    return { handled: true, value: `[Function ${value.name || "anonymous"}]` };
  }
  return { handled: false };
};

const serializeError = (value: Error) => ({
  name: value.name,
  message: truncate(value.message),
  stack: typeof value.stack === "string" ? truncate(value.stack) : undefined,
});

const serializeArray = (
  value: unknown[],
  state: SerializerState,
  depth: number,
  path: string,
  serializeValue: SerializeValue
): unknown[] => {
  const serialized: unknown[] = [];
  const limit = Math.min(value.length, MAX_SERIALIZE_ARRAY_ITEMS);
  for (let index = 0; index < limit; index += 1) {
    serialized.push(
      serializeValue(value[index], state, depth + 1, `${path}[${index}]`)
    );
  }
  if (value.length > limit) {
    serialized.push(`[+${value.length - limit} more]`);
  }
  return serialized;
};

const serializeMap = (
  value: Map<unknown, unknown>,
  state: SerializerState,
  depth: number,
  path: string,
  serializeValue: SerializeValue
) => {
  const entries: unknown[] = [];
  let index = 0;
  for (const [entryKey, entryValue] of value.entries()) {
    if (index >= MAX_SERIALIZE_KEYS) {
      entries.push(`[+${value.size - index} more]`);
      break;
    }
    entries.push([
      serializeValue(entryKey, state, depth + 1, `${path}.mapKey${index}`),
      serializeValue(entryValue, state, depth + 1, `${path}.mapVal${index}`),
    ]);
    index += 1;
  }
  return { type: "Map", entries };
};

const serializeSet = (
  value: Set<unknown>,
  state: SerializerState,
  depth: number,
  path: string,
  serializeValue: SerializeValue
) => {
  const entries: unknown[] = [];
  let index = 0;
  for (const entry of value.values()) {
    if (index >= MAX_SERIALIZE_KEYS) {
      entries.push(`[+${value.size - index} more]`);
      break;
    }
    entries.push(
      serializeValue(entry, state, depth + 1, `${path}.setVal${index}`)
    );
    index += 1;
  }
  return { type: "Set", values: entries };
};

const serializeRecordObject = (
  value: object,
  state: SerializerState,
  depth: number,
  path: string,
  serializeValue: SerializeValue
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  const entries = Object.entries(value);
  const limit = Math.min(entries.length, MAX_SERIALIZE_KEYS);
  for (let index = 0; index < limit; index += 1) {
    const [entryKey, entryValue] = entries[index] ?? [];
    if (typeof entryKey !== "string") {
      continue;
    }
    result[entryKey] = serializeValue(
      entryValue,
      state,
      depth + 1,
      `${path}.${entryKey}`
    );
  }
  if (entries.length > limit) {
    result.truncatedKeys = entries.length - limit;
  }
  return result;
};

type ObjectSerializer = {
  canHandle: (value: object) => boolean;
  serialize: (
    value: object,
    state: SerializerState,
    depth: number,
    path: string,
    serializeValue: SerializeValue
  ) => unknown;
};

const objectSerializers: ObjectSerializer[] = [
  {
    canHandle: (value) => value instanceof Error,
    serialize: (value) => serializeError(value as Error),
  },
  {
    canHandle: (value) => value instanceof Date,
    serialize: (value) => (value as Date).toISOString(),
  },
  {
    canHandle: (value) => value instanceof RegExp,
    serialize: (value) => value.toString(),
  },
  {
    canHandle: (value) => typeof URL !== "undefined" && value instanceof URL,
    serialize: (value) => value.toString(),
  },
  {
    canHandle: (value) =>
      typeof Element !== "undefined" && value instanceof Element,
    serialize: (value) => {
      const element = value as Element;
      return getElementTarget(element) ?? element.tagName.toLowerCase();
    },
  },
  {
    canHandle: (value) =>
      typeof Event !== "undefined" && value instanceof Event,
    serialize: (value) => ({
      type: (value as Event).type,
      target: getElementTarget((value as Event).target),
    }),
  },
  {
    canHandle: (value) => Array.isArray(value),
    serialize: (value, state, depth, path, serializeValue) =>
      serializeArray(value as unknown[], state, depth, path, serializeValue),
  },
  {
    canHandle: (value) => value instanceof Map,
    serialize: (value, state, depth, path, serializeValue) =>
      serializeMap(
        value as Map<unknown, unknown>,
        state,
        depth,
        path,
        serializeValue
      ),
  },
  {
    canHandle: (value) => value instanceof Set,
    serialize: (value, state, depth, path, serializeValue) =>
      serializeSet(value as Set<unknown>, state, depth, path, serializeValue),
  },
  {
    canHandle: (value) =>
      typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer,
    serialize: (value) => `[ArrayBuffer ${(value as ArrayBuffer).byteLength}]`,
  },
  {
    canHandle: (value) =>
      typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value),
    serialize: (value) => {
      const bufferView = value as ArrayBufferView;
      return `[${bufferView.constructor.name} ${bufferView.byteLength}]`;
    },
  },
];

const toSerializableValue: SerializeValue = (value, state, depth, path) => {
  const primitive = serializePrimitive(value);
  if (primitive.handled) {
    return primitive.value;
  }
  if (depth >= MAX_SERIALIZE_DEPTH) {
    return "[MaxDepth]";
  }
  if (typeof value !== "object" || value === null) {
    return Object.prototype.toString.call(value);
  }
  const existingPath = state.seen.get(value);
  if (existingPath) {
    return `[Circular ~${existingPath}]`;
  }
  state.seen.set(value, path);
  for (const serializer of objectSerializers) {
    if (serializer.canHandle(value)) {
      return serializer.serialize(
        value,
        state,
        depth,
        path,
        toSerializableValue
      );
    }
  }
  return serializeRecordObject(value, state, depth, path, toSerializableValue);
};

export function createStringifyValue(reporter: Reporter) {
  return (value: unknown): string => {
    if (typeof value === "string") {
      return truncate(value);
    }
    if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null ||
      typeof value === "undefined"
    ) {
      return String(value);
    }
    try {
      const serialized = toSerializableValue(
        value,
        { seen: new WeakMap() },
        0,
        "$"
      );
      if (typeof serialized === "string") {
        return truncate(serialized);
      }
      return truncate(JSON.stringify(serialized));
    } catch (error) {
      reporter.reportNonFatalError(
        "Failed to stringify console value in capture instrumentation",
        error
      );
      return truncate(Object.prototype.toString.call(value));
    }
  };
}
