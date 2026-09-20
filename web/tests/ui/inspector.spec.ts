import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

const REVIEW_DIR = path.resolve('test-results/review');

const RECT_CORNERS = [
  { x: 0, y: 0, z: 0 },
  { x: 4000, y: 0, z: 0 },
  { x: 4000, y: 3000, z: 0 },
  { x: 0, y: 3000, z: 0 },
];

const row = (page: Page, name: string) => page.locator('.ws-row', { hasText: name });
const dialog = (page: Page) => page.locator('.ws-dialog');

async function seedRectangle(page: Page): Promise<string> {
  return page.evaluate(async (corners) => {
    const api = (window as any).aircad;
    const result = api.commands.addRect(corners);
    if (!result.ok) throw new Error(`seed failed: ${result.error}`);
    api.press('fitAll');
    await new Promise((resolve) => setTimeout(resolve, 700));
    return result.entity.id as string;
  }, RECT_CORNERS);
}

async function seedLine(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = (window as any).aircad;
    const result = api.commands.addLine({ x: 0, y: 3500, z: 0 }, { x: 2500, y: 3500, z: 0 });
    if (!result.ok) throw new Error(`seed failed: ${result.error}`);
    return result.entity.id as string;
  });
}

const selectedId = (page: Page) =>
  page.evaluate(() => (window as any).aircad.selected()?.id ?? null);

test.describe('properties inspector and model browser', () => {
  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(REVIEW_DIR, { recursive: true });
    await page.goto('/');
    await expect(page.locator('.ws-app-bar')).toBeVisible();
  });

  test('model row selects the entity and the inspector edits its size', async ({ page }) => {
    const id = await seedRectangle(page);

    await row(page, 'Rectangle').click();
    await expect.poll(() => selectedId(page)).toBe(id);
    await expect(page.getByLabel('Width (mm)')).toHaveValue('4000');
    await expect(page.getByLabel('Height (mm)')).toHaveValue('3000');
    await page.screenshot({ path: path.join(REVIEW_DIR, 'selected-rect-inspector.png') });

    // Enter commits both fields as one undoable edit.
    await page.getByLabel('Width (mm)').fill('5 m');
    await page.getByLabel('Height (mm)').fill('2 m');
    await page.getByLabel('Height (mm)').press('Enter');
    await expect
      .poll(async () => {
        const entity = await page.evaluate((entityId) => (window as any).aircad.sketch.get(entityId), id);
        const xs = entity.corners.map((c: { x: number }) => c.x);
        const ys = entity.corners.map((c: { y: number }) => c.y);
        return `${Math.max(...xs) - Math.min(...xs)}x${Math.max(...ys) - Math.min(...ys)}`;
      })
      .toBe('5000x2000');
    expect(await page.evaluate(() => (window as any).aircad.sketch.canUndo)).toBe(true);
    // The committed model values replace the raw typed text, even in the
    // still-focused field — no "Object changed" notice after our own Apply.
    await expect(page.getByLabel('Width (mm)')).toHaveValue('5000');
    await expect(page.getByLabel('Height (mm)')).toHaveValue('2000');
    await expect(page.locator('.insp-note')).toBeHidden();

    // Invalid input keeps the draft, shows an inline error, adds no history.
    const sizeForm = page.locator('.insp-form[data-form="size"]');
    await page.getByLabel('Width (mm)').fill('abc');
    await page.getByLabel('Width (mm)').press('Enter');
    await expect(sizeForm.locator('.insp-error')).toContainText('Width:');
    // Only the offending field is marked invalid.
    await expect(sizeForm.locator('input[aria-invalid="true"]')).toHaveCount(1);
    await page.screenshot({ path: path.join(REVIEW_DIR, 'invalid-dimension.png') });
    await expect
      .poll(async () => {
        const entity = await page.evaluate((entityId) => (window as any).aircad.sketch.get(entityId), id);
        const xs = entity.corners.map((c: { x: number }) => c.x);
        return Math.max(...xs) - Math.min(...xs);
      })
      .toBe(5000);

    // Escape resets the draft and clears the inline error.
    await page.getByLabel('Width (mm)').press('Escape');
    await expect(sizeForm.locator('.insp-error')).toBeEmpty();
    await expect(page.getByLabel('Width (mm)')).toHaveValue('5000');
  });

  test('arrow keys move selection in the list and Delete removes the entity', async ({ page }) => {
    const rectId = await seedRectangle(page);
    const lineId = await seedLine(page);

    await row(page, 'Rectangle').click();
    await expect.poll(() => selectedId(page)).toBe(rectId);
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => selectedId(page)).toBe(lineId);
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => selectedId(page)).toBe(rectId);

    await page.keyboard.press('Delete');
    await expect.poll(() => page.evaluate(() => (window as any).aircad.sketch.size)).toBe(1);
    await expect.poll(() => selectedId(page)).toBe(null);
    expect(await page.evaluate((entityId) => (window as any).aircad.sketch.get(entityId) ?? null, rectId)).toBeNull();
  });

  test('help opens as a modal dialog, traps Tab, and restores focus on Escape', async ({ page }) => {
    const helpButton = page.locator('.ws-app-bar').getByRole('button', { name: 'Help', exact: true });
    await helpButton.click();
    await page.locator('.ws-menu').getByRole('button', { name: 'Getting started' }).click();

    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toHaveAttribute('aria-modal', 'true');
    // Focus starts inside and stays inside across several Tab presses.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => !!document.activeElement?.closest('.ws-dialog'));
      expect(inside).toBe(true);
    }
    await page.screenshot({ path: path.join(REVIEW_DIR, 'help-dialog.png') });

    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    const focusBack = await page.evaluate(() => document.activeElement?.textContent ?? '');
    expect(focusBack).toContain('Help');
  });

  test('measure dialog reports invalid input inline and stays open', async ({ page }) => {
    const id = await seedRectangle(page);
    await row(page, 'Rectangle').click();
    await expect.poll(() => selectedId(page)).toBe(id);

    await page.locator('.viewport').focus();
    await page.keyboard.press('l');
    await expect(dialog(page)).toBeVisible();

    await dialog(page).locator('input').fill('-5');
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).locator('.insp-error')).not.toBeEmpty();
    await expect.poll(() => page.evaluate(() => (window as any).aircad.sketch.size)).toBe(1);

    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
  });

  test('push/pull operation shows faces, typed pull updates the preview, Apply commits', async ({ page }) => {
    const id = await seedRectangle(page);
    await row(page, 'Rectangle').click();
    await expect.poll(() => selectedId(page)).toBe(id);

    await page.locator('.ws-command-bar').getByRole('button', { name: 'Push/Pull' }).click();
    await expect(page.locator('.insp-extrude')).toBeVisible();
    // A flat rectangle profile has two faces.
    await expect(page.locator('.insp-extrude select option')).toHaveCount(2);

    await page.getByLabel('Pull distance (mm, signed)').fill('800');
    await page.getByRole('button', { name: 'Update preview' }).click();
    await expect
      .poll(async () => Math.abs((await page.evaluate(() => (window as any).aircad.extrusion()))?.depth ?? 0))
      .toBeCloseTo(800);
    // Solid preview: all six faces selectable, nothing committed yet.
    await expect(page.locator('.insp-extrude select option')).toHaveCount(6);
    await expect.poll(() => page.evaluate(() => (window as any).aircad.sketch.size)).toBe(1);
    await page.screenshot({ path: path.join(REVIEW_DIR, 'pushpull-operation.png') });

    await page.locator('.insp-extrude').getByRole('button', { name: 'Apply' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).aircad.extrusion())).toBeNull();
    const entity = await page.evaluate((entityId) => (window as any).aircad.sketch.get(entityId), id);
    expect(entity.type).toBe('extrusion');
    expect(Math.abs(entity.depth)).toBeCloseTo(800);
  });
});

test.describe('help dialog at 1280x720', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('the wide help dialog fits inside the viewport without clipping', async ({ page }) => {
    await page.goto('/');
    await page.locator('.ws-app-bar').getByRole('button', { name: 'Help', exact: true }).click();
    await page.locator('.ws-menu').getByRole('button', { name: 'Getting started' }).click();
    await expect(dialog(page)).toBeVisible();

    const clip = await dialog(page).evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const content = el.querySelector('.help-content');
      const contentOverflow = content ? content.scrollWidth - content.clientWidth : 0;
      return { left: rect.left, right: rect.right, bottom: rect.bottom, contentOverflow };
    });
    expect(clip.left).toBeGreaterThanOrEqual(0);
    expect(clip.right).toBeLessThanOrEqual(1281);
    expect(clip.bottom).toBeLessThanOrEqual(721);
    // Long content wraps instead of clipping sideways.
    expect(clip.contentOverflow).toBeLessThanOrEqual(1);
  });
});
