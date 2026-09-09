export function unwrap<T>(record: T | undefined | null, message: string): T {
  if (record === undefined || record === null) throw new Error(message);
  return record;
}
