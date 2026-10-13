import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/$slug/customers/")({
  component: CustomersRedirect,
});

// Customers moved under Sales — keep the old URL landing on the right tab.
function CustomersRedirect() {
  const { slug } = Route.useParams();
  return (
    <Navigate
      to="/$slug/sales"
      params={{ slug }}
      search={{ tab: "companies" }}
      replace
    />
  );
}
