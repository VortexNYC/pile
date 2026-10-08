import { test as base, expect, type Page } from "@playwright/test";

import { IssuesPage } from "../pages/issues-page";
import { OnboardingPage } from "../pages/onboarding-page";
import { SignUpPage } from "../pages/sign-up-page";

export interface Member {
  email: string;
  password: string;
  name: string;
  slug: string;
}

function uniqueMember(): Member {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  return {
    email: `e2e-${id}@example.com`,
    password: `Pw-${id}-pile!`,
    name: `E2E ${id}`,
    slug: `e2e-${id}`,
  };
}

/** Sign up a fresh member and create their workspace; lands on Issues. */
export async function signUpWithWorkspace(page: Page, member: Member) {
  const signUp = new SignUpPage(page);
  await signUp.goto();
  await signUp.signUp(member);
  const onboarding = new OnboardingPage(page);
  await onboarding.expectLoaded();
  await onboarding.create(member.name, member.slug);
  const issues = new IssuesPage(page, member.slug);
  await issues.expectLoaded();
}

export const test = base.extend<{ signedIn: Member }>({
  signedIn: async ({ page }, use) => {
    const member = uniqueMember();
    await signUpWithWorkspace(page, member);
    await use(member);
  },
});

export { expect };
