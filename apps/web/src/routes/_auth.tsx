import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth")({
  component: AuthLayout,
});

function AuthLayout() {
  return (
    <div
      data-auth-shell
      className="bg-kumo-canvas flex min-h-dvh flex-col items-center justify-center px-4 py-10"
    >
      <div className="mx-auto flex w-full max-w-md flex-col items-center gap-6">
        <span className="text-kumo-default text-3xl font-semibold tracking-tight">
          Pile
        </span>
        <div className="w-full">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
