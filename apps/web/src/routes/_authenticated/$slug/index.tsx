import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/$slug/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/$slug/issues", params });
  },
});
