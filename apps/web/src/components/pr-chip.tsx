import { Badge } from "@cloudflare/kumo/components/badge";
import { GitMerge, GitPullRequest } from "@phosphor-icons/react";

import { type IssuePrFields, prChip } from "@/lib/pull-request";

const CHECK_DOT = {
  success: "bg-kumo-success",
  failure: "bg-kumo-badge-red",
  pending: "bg-kumo-badge-orange",
  unknown: "bg-kumo-badge-neutral",
} as const;

/** PR state chip + CI dot. `link` makes the chip open the PR — leave it off
 *  where the chip already sits inside another link (issue rows). */
export function PrChip({
  issue,
  link = false,
}: {
  issue: IssuePrFields;
  link?: boolean;
}) {
  const chip = prChip(issue);
  if (!chip) return null;
  const summary = [
    chip.ref ? `Pull request ${chip.ref}` : "Pull request",
    chip.label.toLowerCase(),
    chip.checkLabel,
  ]
    .filter(Boolean)
    .join(" · ");
  const body = (
    <>
      <Badge
        variant={chip.variant}
        icon={chip.state === "merged" ? <GitMerge /> : <GitPullRequest />}
      >
        {chip.ref && link ? `${chip.ref} ${chip.label}` : chip.label}
      </Badge>
      {chip.check ? (
        <span
          data-testid="pr-check-dot"
          className={`size-2 shrink-0 rounded-full ${CHECK_DOT[chip.check]}`}
        />
      ) : null}
    </>
  );
  const className = "inline-flex shrink-0 items-center gap-1.5";
  if (link && chip.href) {
    return (
      <a
        href={chip.href}
        target="_blank"
        rel="noreferrer"
        aria-label={summary}
        title={summary}
        className={`${className} hover:opacity-80`}
      >
        {body}
      </a>
    );
  }
  return (
    <span role="img" aria-label={summary} title={summary} className={className}>
      {body}
    </span>
  );
}
