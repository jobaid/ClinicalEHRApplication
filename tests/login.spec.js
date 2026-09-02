import { test, expect } from "@playwright/test";

test("Nurse cannot access billing", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel(/email/i)
    .fill("nurse@medbill.local");

  await page.getByLabel(/password/i)
    .fill("Nurse@12345");

  await page.getByRole("button", {
    name: /login|sign in/i
  }).click();

  await page.goto("/billing");

  await expect(
    page.getByText(/access denied|unauthorized/i)
  ).toBeVisible();
});