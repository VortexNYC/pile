import { LinkProvider, type LinkComponentProps } from "@cloudflare/kumo/utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, Link, RouterProvider } from "@tanstack/react-router";
import { forwardRef } from "react";
import ReactDOM from "react-dom/client";

import { LoadingState } from "@/components/states";
import { APP_BASE, toRouterPath } from "@/lib/router-path";

import { routeTree } from "./routeTree.gen";

import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (failureCount, error) =>
        failureCount < 2 &&
        !(error instanceof Error && "status" in error && error.status !== 0),
    },
  },
});

// Kumo + better-auth-ui render plain hrefs (`/app/...`); route in-app ones
// through TanStack so navigation stays client-side under the /app basepath.
const AppLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(
  ({ href, to, ...rest }, ref) => {
    const raw =
      typeof href === "string" && href.length > 0
        ? href
        : typeof to === "string"
          ? to
          : "";
    const target = toRouterPath(raw);
    if (target === null) {
      return <a ref={ref} href={raw} {...rest} />;
    }
    const url = new URL(target, "http://localhost");
    const search: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      search[key] = value;
    });
    return <Link ref={ref} to={url.pathname} search={search} {...rest} />;
  }
);
AppLink.displayName = "AppLink";

const router = createRouter({
  routeTree,
  basepath: APP_BASE,
  defaultPreload: "intent",
  defaultPendingComponent: () => <LoadingState />,
  scrollRestoration: true,
  context: { queryClient },
  Wrap: function WrapComponent({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <LinkProvider component={AppLink}>{children}</LinkProvider>
      </QueryClientProvider>
    );
  },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("app");
if (!rootElement) {
  throw new Error("Root element not found");
}
ReactDOM.createRoot(rootElement).render(<RouterProvider router={router} />);
