import { expect, type Page } from "@playwright/test";

export class IssueDetailPage {
  constructor(private readonly page: Page) {}

  async edit(fields: { title?: string }) {
    await this.page.getByRole("button", { name: "Edit" }).first().click();
    if (fields.title !== undefined)
      await this.page.getByLabel("Title").fill(fields.title);
    await this.page.getByRole("button", { name: "Save changes" }).click();
    if (fields.title !== undefined) {
      await expect(
        this.page.getByRole("heading", { name: fields.title, level: 1 })
      ).toBeVisible();
    }
  }

  async addComment(body: string) {
    await this.page.getByLabel("Add a comment").fill(body);
    await this.page
      .getByRole("button", { name: "Comment", exact: true })
      .click();
    await expect(
      this.page.getByTestId("comment").filter({ hasText: body })
    ).toBeVisible();
  }

  async delete() {
    this.page.once("dialog", (dialog) => void dialog.accept());
    await this.page.getByRole("button", { name: "Delete" }).first().click();
  }
}
