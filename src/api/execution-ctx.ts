// `c.executionCtx` throws "This context has no ExecutionContext" when the
// fetch didn't originate from the Workers runtime (tests calling app.fetch
// directly). Guard every call site that wants waitUntil.
export function getExecutionCtx(c: {
  executionCtx?: { waitUntil: (promise: Promise<unknown>) => void };
}): { waitUntil: (promise: Promise<unknown>) => void } | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}
