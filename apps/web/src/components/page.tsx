import { Text } from "@cloudflare/kumo/components/text";
import type { ReactNode } from "react";

export function Page({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <Text variant="heading" as="h1" size="lg">
            {title}
          </Text>
          {description ? (
            <Text variant="secondary" size="sm">
              {description}
            </Text>
          ) : null}
        </div>
        {actions ? <div className="flex gap-2">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}
