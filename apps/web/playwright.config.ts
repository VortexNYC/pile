import { defineConfig, devices } from "@playwright/test";

/**
 * E2E runs against a live stack: `wrangler dev` (API + auth on :8787) and
 * the Vite dev server (:5181, proxying /api and /workspaces). Point
 * PLAYWRIGHT_BASE_URL at a deployed Worker to run against that instead.
 */
export default defineConfig({
  testDir: "./e2e/tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5181",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: "pnpm dev",
        url: "http://localhost:5181/app/",
        reuseExistingServer: true,
        timeout: 60_000,
      },
});
