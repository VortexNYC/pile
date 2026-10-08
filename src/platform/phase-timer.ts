// Per-call phase breakdown for hot paths. Workers advance the clock only
// across I/O, so in production a span measures awaited I/O (D1, RPC, KV) —
// exactly the serialized lookups this exists to surface — while CPU-only
// work reads near zero there.
export interface PhaseTimer {
  mark(phase: string): void;
  elapsedMs(): number;
  phases(): Record<string, number>;
}

export function createPhaseTimer(
  now: () => number = () => performance.now()
): PhaseTimer {
  const start = now();
  let last = start;
  const spans: Record<string, number> = {};
  return {
    mark(phase) {
      const t = now();
      spans[phase] = (spans[phase] ?? 0) + (t - last);
      last = t;
    },
    elapsedMs: () => now() - start,
    phases: () =>
      Object.fromEntries(
        Object.entries(spans).map(([phase, ms]) => [phase, Math.round(ms)])
      ),
  };
}

// Emits one structured line when the call crossed `thresholdMs`, so slow
// writes are attributable from Workers logs without logging every request.
export function logSlowPhases(
  event: string,
  timer: PhaseTimer,
  thresholdMs: number,
  context: Record<string, unknown>
): boolean {
  const totalMs = Math.round(timer.elapsedMs());
  if (totalMs < thresholdMs) return false;
  console.warn(
    JSON.stringify({ event, totalMs, phases: timer.phases(), ...context })
  );
  return true;
}
