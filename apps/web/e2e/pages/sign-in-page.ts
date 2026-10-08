import { expect, type Page } from "@playwright/test";

export class SignInPage {
  constructor(private readonly page: Page) {}

  async goto() {
    await this.page.goto("/app/sign-in");
  }

  async expectLoaded() {
    await expect(this.page).toHaveURL(/\/app\/sign-in/);
    await expect(
      this.page.getByRole("button", { name: /sign in/i })
    ).toBeVisible();
  }

  async signIn(email: string, password: string) {
    await this.page.getByLabel(/^email$/i).fill(email);
    await this.page.getByLabel(/^password$/i).fill(password);
    await this.page.getByRole("button", { name: /sign in/i }).click();
  }
}
