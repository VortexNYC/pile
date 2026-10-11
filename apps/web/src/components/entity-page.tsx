import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Page } from "@/components/page";

/** The unified operating space — every entity detail gets the same
 * skeleton: breadcrumb → title → actions, center column for the
 * story (content, activity, composer), right rail for properties
 * and relations. Entities differ in fields, not in frame. */
export function EntityPage({
  title,
  description,
  actions,
  center,
  rail,
}: {
  title: string | ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  center: ReactNode;
  rail?: ReactNode;
}) {
  return (
    <Page title={title} description={description} actions={actions}>
      <div className="flex gap-8 min-w-0">
        <div className="flex-1 min-w-0 flex flex-col gap-6">{center}</div>
        {rail ? (
          <aside className="hidden lg:block w-72 shrink-0 border-l border-kumo-line pl-6">
            <div className="flex flex-col gap-6">{rail}</div>
          </aside>
        ) : null}
      </div>
    </Page>
  );
}

/** A rail group — labeled section in the right column. */
export function RailSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div>
      <h3 className="text-xs font-medium text-kumo-subtle mb-2">{title}</h3>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

/** A rail link row — navigates to another entity. */
export function RailLink({
  to,
  params,
  children,
}: {
  to: string;
  params: Record<string, string>;
  children: ReactNode;
}) {
  return (
    <Link
      to={to as never}
      params={params as never}
      className="text-sm text-kumo-link hover:underline truncate"
    >
      {children}
    </Link>
  );
}
