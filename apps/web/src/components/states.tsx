import { Button } from "@cloudflare/kumo/components/button";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Loader } from "@cloudflare/kumo/components/loader";
import { WarningCircle } from "@phosphor-icons/react";
import type { ReactNode } from "react";

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      className="flex min-h-40 w-full items-center justify-center"
    >
      <Loader />
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  const message =
    error instanceof Error ? error.message : "Something went wrong.";
  return (
    <div role="alert">
      <Empty
        icon={<WarningCircle size={40} />}
        title="Couldn't load this"
        description={message}
        contents={
          onRetry ? <Button onClick={onRetry}>Try again</Button> : undefined
        }
      />
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <Empty
      icon={icon}
      title={title}
      description={description}
      contents={action}
    />
  );
}
