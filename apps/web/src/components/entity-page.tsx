import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { DotsThree } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Page } from "@/components/page";

/** The unified operating space — every entity detail gets the same
 * skeleton: breadcrumb → title → actions, center column for the
 * story (content, activity, composer), right rail for properties
 * and relations. Entities differ in fields, not in frame. */
/** PILE-653 — the rail is no longer lg-only: under `lg` it stacks below
 *  the center column so mobile readers still get properties, relations,
 *  and field controls; at `lg` it returns to the bordered side rail. */
export const ENTITY_CENTER_CLASS = "flex-1 min-w-0 flex flex-col gap-6";
export const ENTITY_RAIL_CLASS =
  "w-full lg:w-72 shrink-0 border-t border-kumo-line pt-6 lg:border-t-0 lg:border-l lg:pl-6 lg:pt-0";

export function EntityPage({
  title,
  description,
  actions,
  menu,
  center,
  rail,
}: {
  title: string | ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Kebab menu items — every detail page gets the same ··· overflow
   * (copy link, favorite, delete…) instead of scattering buttons. */
  menu?: ReactNode;
  center: ReactNode;
  rail?: ReactNode;
}) {
  return (
    <Page
      title={title}
      description={description}
      actions={
        menu ? (
          <>
            {actions}
            <DropdownMenu>
              <DropdownMenu.Trigger
                render={
                  <button
                    type="button"
                    aria-label="More actions"
                    className="hover:bg-kumo-tint rounded-md p-2 text-kumo-subtle"
                  >
                    <DotsThree size={18} weight="bold" />
                  </button>
                }
              />
              <DropdownMenu.Content>{menu}</DropdownMenu.Content>
            </DropdownMenu>
          </>
        ) : (
          actions
        )
      }
    >
      <div className="flex min-w-0 flex-col gap-8 lg:flex-row">
        <div className={ENTITY_CENTER_CLASS}>{center}</div>
        {rail ? (
          <aside className={ENTITY_RAIL_CLASS}>
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
