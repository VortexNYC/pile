import { expect, type Page } from "@playwright/test";

export class OnboardingPage {
  constructor(private readonly page: Page) {}

  async expectLoaded() {
    await expect(
      this.page.getByRole("heading", { name: "Create your workspace" })
    ).toBeVisible();
  }

  async create(name: string, slug: string) {
    await this.page.getByLabel("Workspace name").fill(name);
    await this.page.getByLabel("URL name").fill(slug);
    await this.page.getByRole("button", { name: "Create workspace" }).click();
  }
}
