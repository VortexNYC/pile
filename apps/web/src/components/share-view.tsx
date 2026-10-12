import { LoadingState, ErrorState } from "@/components/states";

export function ShareShell({
  eyebrow,
  title,
  children,
  error,
  pending,
}: {
  eyebrow: string;
  title: string;
  children?: React.ReactNode;
  error?: unknown;
  pending?: boolean;
}) {
  return (
    <div className="bg-kumo-canvas flex min-h-dvh flex-col items-center px-4 py-12">
      <div className="w-full max-w-2xl flex flex-col gap-6">
        <div className="flex items-baseline gap-3">
          <span className="text-kumo-default text-xl font-semibold tracking-tight">
            Pile
          </span>
          <span className="text-xs font-medium text-kumo-subtle uppercase">
            {eyebrow}
          </span>
        </div>
        <h1 className="text-2xl font-semibold text-kumo-default leading-tight">
          {title}
        </h1>
        {pending ? (
          <LoadingState />
        ) : error ? (
          <ErrorState error={error} />
        ) : (
          children
        )}
        <p className="text-xs text-kumo-subtle mt-8">
          Shared via Pile — read-only view
        </p>
      </div>
    </div>
  );
}
