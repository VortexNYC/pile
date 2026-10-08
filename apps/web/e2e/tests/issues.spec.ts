import { expect, test } from "../fixtures/auth";
import { IssueDetailPage } from "../pages/issue-detail-page";
import { IssuesPage } from "../pages/issues-page";
import { WorkspaceShell } from "../pages/shell";

test("issues: create, edit, comment, delete", async ({ page, signedIn }) => {
  const issues = new IssuesPage(page, signedIn.slug);
  const detail = new IssueDetailPage(page);
  await issues.createIssue("Printer on floor 3 is jammed", "Since Monday.");
  await detail.edit({ title: "Printer on floor 3 still jammed" });
  await detail.addComment("Facilities has been notified.");
  await detail.delete();
  await issues.expectLoaded();
  await expect(issues.row("Printer on floor 3")).toHaveCount(0);
});

test("the console hides CLI-only concepts", async ({ page, signedIn }) => {
  const issues = new IssuesPage(page, signedIn.slug);
  await issues.createIssue("Check copy", "");
  await expect(
    page.getByText(/\b(repo(sitory)?|branch|dispatch|lanes?|billing)\b/i)
  ).toHaveCount(0);
  const shell = new WorkspaceShell(page);
  await expect(shell.bell()).toBeVisible();
  await shell.nav("Documents").click();
  await expect(
    page.getByRole("heading", { name: "Documents", level: 1 })
  ).toBeVisible();
  await shell.nav("Support").click();
  await expect(
    page.getByRole("heading", { name: "Support", level: 1 })
  ).toBeVisible();
  await shell.nav("Customers").click();
  await expect(
    page.getByRole("heading", { name: "Customers", level: 1 })
  ).toBeVisible();
});
