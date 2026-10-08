import {
  createFileRoute,
  Navigate,
  Outlet,
  useLocation,
} from "@tanstack/react-router";

import { LoadingState } from "@/components/states";
import { betterAuthClient } from "@/lib/better-auth";
import { appHref } from "@/lib/router-path";

export const Route = createFileRoute("/_authenticated")({
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { data: session, isPending } = betterAuthClient.useSession();
  const { pathname } = useLocation();

  if (isPending) {
    return <LoadingState label="Checking your session" />;
  }
  if (!session) {
    return (
      <Navigate
        to="/sign-in"
        search={{ redirect: appHref(pathname) }}
        replace
      />
    );
  }
  return <Outlet />;
}
