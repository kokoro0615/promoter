import { test, expect } from '@playwright/test';

// Smoke: dev login -> promoter sees events -> admin sees audit log.
// Requires seeded dev DB (`pnpm devdb:start && pnpm db:seed`).

test('login and promoter flow renders', async ({ page }) => {
  await page.goto('/#/login');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  await page.getByPlaceholder('subject').fill('promoter');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(/signed in as/)).toBeVisible();
  await expect(page.getByText(/permissions\)/).first()).toBeVisible();

  await page.getByRole('link', { name: 'Promoter' }).click();
  await expect(page.getByRole('heading', { name: 'Guest registration' }))
    .toBeVisible();
  // Seed event is selectable.
  await expect(page.locator('select').first()).not.toHaveValue('');
});

test('admin sees events and audit log', async ({ page }) => {
  await page.goto('/#/login');
  await page.getByPlaceholder('subject').fill('admin');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(/signed in as/)).toBeVisible();

  await page.getByRole('link', { name: 'Admin' }).click();
  await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
});

test('unpaired kiosk asks for pairing code', async ({ page }) => {
  await page.goto('/#/kiosk');
  await expect(page.getByRole('heading', { name: 'Pair this device' }))
    .toBeVisible({ timeout: 10_000 });
});
