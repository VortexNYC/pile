import { expect, test } from "../fixtures/auth";
import { SignInPage } from "../pages/sign-in-page";

test("signed-out visitors are sent to sign in", async ({ page }) => {
  await page.goto("/app/some-workspace/issues");
  await new SignInPage(page).expectLoaded();
});

test("a new member signs up, creates a workspace, and can sign back in", async ({
  page,
  signedIn,
}) => {
  await page.context().clearCookies();
  const signIn = new SignInPage(page);
  await signIn.goto();
  await signIn.signIn(signedIn.email, signedIn.password);
  await expect(page).toHaveURL(new RegExp(`/app/${signedIn.slug}/issues`));
});
