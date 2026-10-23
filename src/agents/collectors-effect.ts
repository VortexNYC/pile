import { Effect, Schedule, Schema } from "effect";

import {
  type MerchantCandidate,
  type MerchantSourceRow,
  pullSource,
} from "./collectors.js";

export class CollectorSourceError extends Schema.TaggedError<CollectorSourceError>()(
  "CollectorSourceError",
  {
    sourceId: Schema.String,
    kind: Schema.String,
    message: Schema.String,
  }
) {}

export const pullSourceEffect = Effect.fn("pullSourceEffect")(function* (
  source: MerchantSourceRow,
  env?: Record<string, string | undefined>,
  options?: { limit?: number; offset?: number; extraWhere?: string }
): Effect.fn.Return<
  { candidates: MerchantCandidate[]; newCursor: string | null },
  CollectorSourceError
> {
  return yield* Effect.tryPromise({
    try: () => pullSource(source, env, options),
    catch: (err) =>
      new CollectorSourceError({
        sourceId: source.id,
        kind: source.kind,
        message: err instanceof Error ? err.message : String(err),
      }),
  }).pipe(
    Effect.retry(
      Schedule.max([
        Schedule.exponential("100 millis"),
        Schedule.recurs(1),
      ]).pipe(
        Schedule.setInputType<CollectorSourceError>(),
        Schedule.while(({ input }) => !input.message.includes("unsupported"))
      )
    )
  );
});
