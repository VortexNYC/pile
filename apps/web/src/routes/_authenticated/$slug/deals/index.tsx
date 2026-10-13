import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/$slug/deals/")({
  component: DealsRedirect,
});

// Deals moved under Sales — keep the old URL landing on the pipeline tab.
function DealsRedirect() {
  const { slug } = Route.useParams();
  return (
    <Navigate
      to="/$slug/sales"
      params={{ slug }}
      search={{ tab: "deals" }}
      replace
    />
  );
}
