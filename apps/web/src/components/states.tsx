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

function errorStatus(error: unknown): number | null {
  if (error && typeof error === "object" && "status" in error) {
    const s = (error as { status: unknown }).status;
    return typeof s === "number" ? s : null;
  }
  return null;
}

export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  const status = errorStatus(error);
  const forbidden = status === 401 || status === 403;
  const message = forbidden
    ? "You don't have access to this — ask a workspace admin."
    : error instanceof Error
      ? error.message
      : "Something went wrong.";
  return (
    <div role="alert">
      <Empty
        icon={<WarningCircle size={40} />}
        title={forbidden ? "Access restricted" : "Couldn't load this"}
        description={message}
        contents={
          onRetry && !forbidden ? (
            <Button onClick={onRetry}>Try again</Button>
          ) : undefined
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
