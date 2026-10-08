import type { Page } from "@playwright/test";

export class WorkspaceShell {
  constructor(private readonly page: Page) {}

  nav(
    name:
      | "Issues"
      | "Documents"
      | "Support"
      | "Customers"
      | "Members"
      | "Account"
  ) {
    return this.page
      .getByRole("navigation", { name: "Workspace navigation" })
      .getByRole("link", { name });
  }

  bell() {
    return this.page.getByRole("button", { name: /^Notifications/ });
  }
}
