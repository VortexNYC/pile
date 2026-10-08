import type { Page } from "@playwright/test";

export class SignUpPage {
  constructor(private readonly page: Page) {}

  async goto() {
    await this.page.goto("/app/sign-up");
  }

  async signUp({
    name,
    email,
    password,
  }: {
    name: string;
    email: string;
    password: string;
  }) {
    await this.page.getByLabel(/^name$/i).fill(name);
    await this.page.getByLabel(/^email$/i).fill(email);
    await this.page.getByLabel(/^password$/i).fill(password);
    const confirm = this.page.getByLabel(/confirm password/i);
    if (await confirm.count()) await confirm.fill(password);
    await this.page
      .getByRole("button", { name: /create account|sign up/i })
      .click();
  }
}
