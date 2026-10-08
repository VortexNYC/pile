import { expect, test } from "../fixtures/auth";

test("documents: create, edit, delete", async ({ page, signedIn }) => {
  await page.goto(`/app/${signedIn.slug}/documents`);
  await page.getByRole("button", { name: "New document" }).click();
  await page.getByLabel("Title").fill("Onboarding checklist");
  await page.getByLabel("Content").fill("1. Laptop\n2. Badge");
  await page.getByRole("button", { name: "Create document" }).click();
  await expect(
    page.getByRole("heading", { name: "Onboarding checklist", level: 1 })
  ).toBeVisible();
  await expect(page.getByText("Badge")).toBeVisible();
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Title").fill("Onboarding checklist v2");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByRole("heading", { name: "Onboarding checklist v2", level: 1 })
  ).toBeVisible();
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(
    page.getByRole("heading", { name: "Documents", level: 1 })
  ).toBeVisible();
});

test("customers: add, rename, delete", async ({ page, signedIn }) => {
  await page.goto(`/app/${signedIn.slug}/customers`);
  await page.getByRole("button", { name: "Add customer" }).click();
  await page.getByLabel("Company name").fill("Globex");
  await page.getByRole("button", { name: "Save customer" }).click();
  await page
    .getByRole("table", { name: "Customers" })
    .getByRole("link", { name: "Globex" })
    .click();
  await page.getByLabel("Company name").fill("Globex Corp");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("heading", { name: "Globex Corp", level: 1 })
  ).toBeVisible();
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("No customers yet")).toBeVisible();
});

test("support: open a ticket and add a note", async ({ page, signedIn }) => {
  await page.goto(`/app/${signedIn.slug}/tickets`);
  await page.getByRole("button", { name: "New ticket" }).click();
  await page
    .getByLabel("Customer email")
    .fill(`buyer-${Date.now()}@example.com`);
  await page.getByLabel("Subject").fill("Order never arrived");
  await page.getByLabel("What did they say?").fill("Where is my order?");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(
    page.getByRole("heading", { name: /Order never arrived/, level: 1 })
  ).toBeVisible();
  // No reply channel is connected in a fresh workspace, so only notes work.
  await expect(
    page.getByRole("button", { name: "Reply to customer" })
  ).toBeDisabled();
  await page.getByLabel("Internal note").fill("Carrier says delayed.");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(
    page
      .getByTestId("ticket-event")
      .filter({ hasText: "Carrier says delayed." })
  ).toBeVisible();
});
