import { expect, type Page } from "@playwright/test";

export class IssuesPage {
  constructor(
    private readonly page: Page,
    private readonly slug: string
  ) {}

  async goto() {
    await this.page.goto(`/app/${this.slug}/issues`);
  }

  async expectLoaded() {
    await expect(
      this.page.getByRole("heading", { name: "Issues", level: 1 })
    ).toBeVisible();
  }

  async createIssue(title: string, description: string) {
    await this.page.getByRole("button", { name: "New issue" }).click();
    await this.page.getByLabel("Title").fill(title);
    await this.page.getByLabel("Description").fill(description);
    await this.page.getByRole("button", { name: "Create issue" }).click();
    await expect(
      this.page.getByRole("heading", { name: title, level: 1 })
    ).toBeVisible();
  }

  row(title: string) {
    return this.page
      .getByRole("table", { name: "Issues" })
      .getByRole("link", { name: new RegExp(title) });
  }
}
