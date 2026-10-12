import {
  createFileRoute,
  Navigate,
  Outlet,
  useLocation,
} from "@tanstack/react-router";
import { useEffect } from "react";

import { LoadingState } from "@/components/states";
import { betterAuthClient } from "@/lib/better-auth";
import { identifyPosthog, resetPosthog } from "@/lib/observability";
import { appHref } from "@/lib/router-path";

export const Route = createFileRoute("/_authenticated")({
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { data: session, isPending } = betterAuthClient.useSession();
  const { pathname } = useLocation();

  useEffect(() => {
    if (session?.user) {
      identifyPosthog(session.user);
    } else {
      resetPosthog();
    }
  }, [session]);

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
