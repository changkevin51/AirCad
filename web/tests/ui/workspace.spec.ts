import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures';
import type { Locator, Page } from '@playwright/test';

const REVIEW_DIR = path.resolve('test-results/review');

const SIZES = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
];

const RECT_CORNERS = [
  { x: 0, y: 0, z: 0 },
  { x: 4000, y: 0, z: 0 },
  { x: 4000, y: 3000, z: 0 },
  { x: 0, y: 3000, z: 0 },
];

type Rect = { x: number; y: number; width: number; height: number };

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

const viewportEl = (page: Page) => page.locator('.viewport');
const browserToggle = (page: Page) => page.locator('.ws-app-bar').getByRole('button', { name: 'Model panel' });
const inspectorToggle = (page: Page) => page.locator('.ws-app-bar').getByRole('button', { name: 'Inspector panel' });
const browserPanel = (page: Page) => page.locator('.ws-panel', { has: page.locator('.ws-browser__body') });
const inspectorPanel = (page: Page) => page.locator('.ws-panel', { has: page.locator('.ws-inspector__body') });

async function ensureVisible(page: Page, toggle: Locator, panel: Locator): Promise<void> {
  if (!(await panel.isVisible())) await toggle.click();
  await expect(panel).toBeVisible();
}

async function seedRectangle(page: Page): Promise<string> {
  const id = await page.evaluate(async (corners) => {
    const api = (window as any).aircad;
    const result = api.commands.addRect(corners);
    if (!result.ok) throw new Error(`seed failed: ${result.error}`);
    api.press('viewFit');
    // Let the fit-view transition finish before projecting.
    await new Promise((resolve) => setTimeout(resolve, 700));
    return result.entity.id as string;
  }, RECT_CORNERS);
  return id;
}

async function clickEntity(page: Page, id: string): Promise<void> {
  // Pick the midpoint of the first edge of the seeded rectangle; a corner can
  // land on a different entity edge after transforms.
  const local = await page.evaluate(() => {
    const api = (window as any).aircad;
    return api.project({ x: 2000, y: 0, z: 0 });
  });
  expect(local, `projected pick point for ${id}`).not.toBeNull();
  const box = await viewportEl(page).boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + local!.x, box!.y + local!.y);
}

async function selectedId(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as any).aircad.selected()?.id ?? null);
}

for (const size of SIZES) {
  test.describe(`workspace layout at ${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    test.beforeEach(async ({ page }) => {
      fs.mkdirSync(REVIEW_DIR, { recursive: true });
      await page.goto('/');
      await expect(page.locator('.ws-app-bar')).toBeVisible();
    });

    test('docked regions frame the viewport without overflow', async ({ page }) => {
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(size.width + 1);
      expect(overflow.bodyScrollWidth).toBeLessThanOrEqual(size.width + 1);

      const box = await viewportEl(page).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThan(0);
      expect(box!.height).toBeGreaterThan(0);

      for (const selector of ['.ws-app-bar', '.ws-command-bar', '.ws-view-header', '.ws-status-bar']) {
        const region = page.locator(selector);
        await expect(region).toBeVisible();
        const regionBox = await region.boundingBox();
        expect(regionBox).not.toBeNull();
        expect(overlaps(regionBox!, box!), `${selector} must not overlap the viewport`).toBe(false);
      }

      // Side panels open: the viewport must still be a usable size.  The
      // compact band (1024-1279px) allows only one side at a time, so this is
      // the largest remaining viewport rather than literally both-open.
      await ensureVisible(page, browserToggle(page), browserPanel(page));
      await ensureVisible(page, inspectorToggle(page), inspectorPanel(page));
      const grown = await viewportEl(page).boundingBox();
      expect(grown).not.toBeNull();
      if (size.width === 1280) {
        // At least 1280 - 260 inspector - 200 browser; height minus chrome = 582.
        expect(grown!.width).toBeGreaterThanOrEqual(800);
        expect(grown!.height).toBeGreaterThanOrEqual(560);
      }
    });

    test('draw, select via projected coordinates, and keep selection after panel toggles', async ({ page }) => {
      await page.screenshot({ path: path.join(REVIEW_DIR, `empty-${size.width}x${size.height}.png`), fullPage: false });

      const id = await seedRectangle(page);
      expect(await page.evaluate(() => (window as any).aircad.sketch.size)).toBe(1);

      await clickEntity(page, id);
      await expect.poll(() => selectedId(page)).toBe(id);
      await page.screenshot({ path: path.join(REVIEW_DIR, `selected-${size.width}x${size.height}.png`), fullPage: false });

      // Collapsing each panel must not disturb selection or drawing.
      await browserToggle(page).click();
      await inspectorToggle(page).click();
      await page.evaluate(() => (window as any).aircad.press('escape'));
      await clickEntity(page, id);
      await expect.poll(() => selectedId(page)).toBe(id);
    });

    test('keyboard on chrome does not reach the canvas', async ({ page }) => {
      const id = await seedRectangle(page);

      const gridToggle = page.getByRole('button', { name: /^Grid snap/ });
      await gridToggle.focus();
      const before = await gridToggle.getAttribute('aria-pressed');
      const sizeBefore = await page.evaluate(() => (window as any).aircad.sketch.size);

      await page.keyboard.press('Space');
      await expect(gridToggle).toHaveAttribute('aria-pressed', before === 'true' ? 'false' : 'true');
      await page.keyboard.press('Enter');
      await expect(gridToggle).toHaveAttribute('aria-pressed', before ?? 'true');

      expect(await page.evaluate(() => (window as any).aircad.sketch.size)).toBe(sizeBefore);
      expect(await page.evaluate((entityId) => (window as any).aircad.sketch.get(entityId), id)).not.toBeNull();
    });

    test('Tab inside the work-plane select does not cycle the plane', async ({ page }) => {
      const planeSelect = page.getByRole('combobox', { name: 'Work plane' });
      await planeSelect.focus();
      const before = await page.evaluate(() => {
        const api = (window as any).aircad;
        return { kind: api.plane().kind, mode: api.planeMode() };
      });
      await page.keyboard.press('Tab');
      const after = await page.evaluate(() => {
        const api = (window as any).aircad;
        return { kind: api.plane().kind, mode: api.planeMode() };
      });
      expect(after).toEqual(before);
      await expect(planeSelect).not.toBeFocused();
    });
  });
}

test.describe('workspace layout at 1024x768 (compact band)', () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(REVIEW_DIR, { recursive: true });
    await page.goto('/');
    await expect(page.locator('.ws-app-bar')).toBeVisible();
  });

  test('only one side panel can be open and the viewport stays usable', async ({ page }) => {
    await ensureVisible(page, inspectorToggle(page), inspectorPanel(page));
    await ensureVisible(page, browserToggle(page), browserPanel(page));
    // Compact band: opening the browser closes the inspector.
    await expect(inspectorPanel(page)).toBeHidden();
    await ensureVisible(page, inspectorToggle(page), inspectorPanel(page));
    await expect(browserPanel(page)).toBeHidden();

    const box = await viewportEl(page).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(500);
    expect(box!.height).toBeGreaterThanOrEqual(500);

    await page.screenshot({ path: path.join(REVIEW_DIR, 'compact-1024x768.png'), fullPage: false });
  });
});

test.describe('workspace layout at 1920x1080', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(REVIEW_DIR, { recursive: true });
    await page.goto('/');
    await expect(page.locator('.ws-app-bar')).toBeVisible();
  });

  test('docked regions frame the viewport without overflow', async ({ page }) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(overflow).toBeLessThanOrEqual(1921);
    const box = await viewportEl(page).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(1200);
    await page.screenshot({ path: path.join(REVIEW_DIR, 'empty-1920x1080.png'), fullPage: false });
  });

  test('selected line and box review captures', async ({ page }) => {
    await page.evaluate(async () => {
      const api = (window as any).aircad;
      const line = api.commands.addLine({ x: 0, y: 0, z: 0 }, { x: 4000, y: 0, z: 0 });
      if (!line.ok) throw new Error(`line seed failed: ${line.error}`);
      api.press('viewFit');
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    const local = await page.evaluate(() => (window as any).aircad.project({ x: 2000, y: 0, z: 0 }));
    const box = await viewportEl(page).boundingBox();
    await page.mouse.click(box!.x + local!.x, box!.y + local!.y);
    await expect.poll(async () => (await selectedId(page)) !== null).toBe(true);
    await page.screenshot({ path: path.join(REVIEW_DIR, 'selected-line.png'), fullPage: false });

    const boxId = await page.evaluate(async () => {
      const api = (window as any).aircad;
      const rect = api.commands.addRect([
        { x: -1000, y: 0, z: -1000 },
        { x: 2000, y: 0, z: -1000 },
        { x: 2000, y: 0, z: 2000 },
        { x: -1000, y: 0, z: 2000 },
      ]);
      if (!rect.ok) throw new Error(`rect seed failed: ${rect.error}`);
      const extruded = api.commands.extrude(rect.entity.id, 800);
      if (!extruded.ok) throw new Error(`extrude failed: ${extruded.error}`);
      api.press('viewFit');
      await new Promise((resolve) => setTimeout(resolve, 700));
      return rect.entity.id as string;
    });
    await page.getByRole('option', { name: /Box/ }).click();
    await expect.poll(() => selectedId(page)).toBe(boxId);
    await page.screenshot({ path: path.join(REVIEW_DIR, 'selected-box.png'), fullPage: false });
  });
});
