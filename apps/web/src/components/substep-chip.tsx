import { Badge } from "@cloudflare/kumo/components/badge";
import { CheckCircle, Warning } from "@phosphor-icons/react";

export interface SubStepProgress {
  total: number;
  done: number;
  blocked: number;
  ownerAgent: string | null;
}

/** PILE-414 — board chip: required sub-step progress for the issue's
 *  current stage ("2/4"), red when required steps are still open, plus
 *  the owner agent of the next open required step in the tooltip. Only
 *  renders when the stage actually has required steps. */
export function SubStepChip({
  progress,
}: {
  progress: SubStepProgress | null | undefined;
}) {
  if (!progress || progress.total === 0) return null;
  const complete = progress.blocked === 0;
  return (
    <span
      title={
        complete
          ? "All required sub-steps complete"
          : `${progress.blocked} required step${progress.blocked === 1 ? "" : "s"} open` +
            (progress.ownerAgent ? ` — next: ${progress.ownerAgent}` : "")
      }
    >
      <Badge
        variant={complete ? "success" : "secondary"}
        icon={complete ? <CheckCircle /> : <Warning />}
      >
        {progress.done}/{progress.total}
      </Badge>
    </span>
  );
}
