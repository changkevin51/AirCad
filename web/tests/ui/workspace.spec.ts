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

async function seedHouse(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const api = (window as any).aircad;
    const rect = api.commands.addRect([
      { x: 0, y: 0, z: 0 },
      { x: 4000, y: 0, z: 0 },
      { x: 4000, y: 3000, z: 0 },
      { x: 0, y: 3000, z: 0 },
    ]);
    if (!rect.ok) throw new Error(rect.error);
    const body = api.commands.extrude(rect.entity.id, 2500);
    if (!body.ok) throw new Error(body.error);
    const roof = api.commands.addTriangle([
      { x: 0, y: 0, z: 2500 },
      { x: 4000, y: 0, z: 2500 },
      { x: 2000, y: 0, z: 4000 },
    ]);
    if (!roof.ok) throw new Error(roof.error);
    const prism = api.commands.extrude(roof.entity.id, 3000);
    if (!prism.ok) throw new Error(prism.error);
    api.press('fitAll');
    await new Promise((resolve) => setTimeout(resolve, 700));
  });
}

async function seedRectangle(page: Page): Promise<string> {
  const id = await page.evaluate(async (corners) => {
    const api = (window as any).aircad;
    const result = api.commands.addRect(corners);
    if (!result.ok) throw new Error(`seed failed: ${result.error}`);
    api.press('fitAll');
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
      await page.evaluate(() => (window as any).aircad.press('cancel'));
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
      api.press('fitAll');
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
      api.press('fitAll');
      await new Promise((resolve) => setTimeout(resolve, 700));
      return rect.entity.id as string;
    });
    await page.getByRole('option', { name: /Box/ }).click();
    await expect.poll(() => selectedId(page)).toBe(boxId);
    await page.screenshot({ path: path.join(REVIEW_DIR, 'selected-box.png'), fullPage: false });
  });
});

test.describe('presentation', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(REVIEW_DIR, { recursive: true });
    await page.goto('/');
    await expect(page.locator('.ws-app-bar')).toBeVisible();
  });

  test('Reveal is disabled on an empty sketch and Display stays on X-ray', async ({ page }) => {
    const reveal = page.getByRole('button', { name: /^Reveal/ });
    await expect(reveal).toBeDisabled();
    await expect(page.getByRole('combobox', { name: 'Display style' })).toHaveValue('xray');
  });

  test('enters a read-only Reveal and restores the editing layout', async ({ page }) => {
    await seedHouse(page);
    const reveal = page.getByRole('button', { name: /^Reveal/ });
    await expect(reveal).toBeEnabled();
    await page.screenshot({ path: path.join(REVIEW_DIR, 'house-xray-1280x720.png') });
    await page.getByRole('combobox', { name: 'Display style' }).selectOption('shaded');
    await page.screenshot({ path: path.join(REVIEW_DIR, 'house-shaded-1280x720.png') });

    await reveal.click();
    await expect(page.locator('.workspace')).toHaveClass(/ws--presentation/);
    await expect(page.locator('.ws-app-bar')).toBeHidden();
    await expect(page.locator('.ws-command-bar')).toBeHidden();
    await expect(browserPanel(page)).toBeHidden();
    await expect(inspectorPanel(page)).toBeHidden();
    await expect(page.getByRole('button', { name: /Back to editing/ })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Display style' })).toBeHidden();
    await page.screenshot({ path: path.join(REVIEW_DIR, 'reveal-1280x720.png') });

    const size = await page.evaluate(() => (window as any).aircad.sketch.size);
    await page.keyboard.press('Delete');
    expect(await page.evaluate(() => (window as any).aircad.sketch.size)).toBe(size);

    await page.getByRole('button', { name: /Back to editing/ }).click();
    await expect(page.locator('.ws-app-bar')).toBeVisible();
    await expect(page.locator('.ws-command-bar')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Display style' })).toHaveValue('shaded');
    expect(await page.evaluate(() => (window as any).aircad.sketch.size)).toBe(size);
    await page.screenshot({ path: path.join(REVIEW_DIR, 'restored-editing-1280x720.png') });
  });

  test('D and Esc toggle Reveal and F6 stays on visible regions', async ({ page }) => {
    await seedRectangle(page);
    await page.locator('.viewport').focus();
    await page.keyboard.press('d');
    await expect(page.locator('.workspace')).toHaveClass(/ws--presentation/);
    await page.keyboard.press('F6');
    await expect(page.locator('.ws-view-header')).toContainText('Back to editing');
    await page.keyboard.press('Escape');
    await expect(page.locator('.ws-app-bar')).toBeVisible();
  });

  test('focusing a guarded control mid-draft does not destroy the stroke', async ({ page }) => {
    const box = await viewportEl(page).boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + 300, box!.y + 300);
    await page.mouse.down();
    await page.mouse.move(box!.x + 520, box!.y + 220, { steps: 5 });
    // Focus lands on the marked Display select; the draft must survive it.
    await page.getByRole('combobox', { name: 'Display style' }).focus();
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => (window as any).aircad.sketch.size)).toBeGreaterThan(0);
  });
});

test.describe('presentation at 1440x900', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(REVIEW_DIR, { recursive: true });
    await page.goto('/');
    await expect(page.locator('.ws-app-bar')).toBeVisible();
  });

  test('Reveal is read-only for pointer input and restores open panels', async ({ page }) => {
    await seedHouse(page);
    await ensureVisible(page, inspectorToggle(page), inspectorPanel(page));

    await page.getByRole('button', { name: /^Reveal/ }).click();
    await expect(page.locator('.workspace')).toHaveClass(/ws--presentation/);
    await expect(inspectorPanel(page)).toBeHidden();
    await page.screenshot({ path: path.join(REVIEW_DIR, 'reveal-readonly-1440x900.png') });

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(overflow).toBeLessThanOrEqual(1441);

    const box = await viewportEl(page).boundingBox();
    expect(box).not.toBeNull();
    const point = await page.evaluate(() => (window as any).aircad.project({ x: 2000, y: 1500, z: 1250 }));
    expect(point).not.toBeNull();
    await page.mouse.click(box!.x + point!.x, box!.y + point!.y);
    expect(await selectedId(page)).toBeNull();

    const size = await page.evaluate(() => (window as any).aircad.sketch.size);
    await page.mouse.move(box!.x + 400, box!.y + 300);
    await page.mouse.down();
    await page.mouse.move(box!.x + 600, box!.y + 220, { steps: 5 });
    await page.mouse.up();
    expect(await page.evaluate(() => (window as any).aircad.sketch.size)).toBe(size);

    const planeBefore = await page.evaluate(() => {
      const api = (window as any).aircad;
      return { kind: api.plane().kind, mode: api.planeMode() };
    });
    await page.getByRole('button', { name: /^Top/ }).click();
    const planeAfter = await page.evaluate(() => {
      const api = (window as any).aircad;
      return { kind: api.plane().kind, mode: api.planeMode() };
    });
    expect(planeAfter).toEqual(planeBefore);

    await page.keyboard.press('d');
    await expect(page.locator('.ws-app-bar')).toBeVisible();
    await expect(inspectorPanel(page)).toBeVisible();
    await page.screenshot({ path: path.join(REVIEW_DIR, 'reveal-restored-1440x900.png') });
  });

  test('Reveal screenshots at the larger review size', async ({ page }) => {
    await seedHouse(page);
    await page.screenshot({ path: path.join(REVIEW_DIR, 'house-xray-1440x900.png') });
    await page.getByRole('combobox', { name: 'Display style' }).selectOption('shaded');
    await page.screenshot({ path: path.join(REVIEW_DIR, 'house-shaded-1440x900.png') });
    await page.getByRole('button', { name: /^Reveal/ }).click();
    await expect(page.locator('.workspace')).toHaveClass(/ws--presentation/);
    await page.screenshot({ path: path.join(REVIEW_DIR, 'reveal-1440x900.png') });
    await page.getByRole('button', { name: /Back to editing/ }).click();
    await expect(page.locator('.ws-app-bar')).toBeVisible();
    await page.screenshot({ path: path.join(REVIEW_DIR, 'restored-editing-1440x900.png') });
  });
});

test.describe('native sketch files', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(REVIEW_DIR, { recursive: true });
    await page.goto('/');
    await expect(page.locator('.ws-app-bar')).toBeVisible();
  });

  test('Save downloads JSON and a confirmed Open replaces the scene', async ({ page }) => {
    await seedHouse(page);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /^AirCAD/ }).click();
    await page.getByRole('button', { name: /Save sketch/ }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('aircad-sketch.aircad.json');
    const filePath = path.join(REVIEW_DIR, download.suggestedFilename());
    await download.saveAs(filePath);

    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /^AirCAD/ }).click();
    await page.getByRole('button', { name: /Open sketch/ }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles(filePath);
    await expect(page.getByRole('heading', { name: 'Open sketch' })).toBeVisible();
    await page.screenshot({ path: path.join(REVIEW_DIR, 'native-open-confirm-1280x720.png') });
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).aircad.sketch.canUndo)).toBe(false);
    expect(await page.evaluate(() => (window as any).aircad.sketch.size)).toBeGreaterThan(0);
  });

  test('invalid Open leaves the sketch unchanged', async ({ page }) => {
    const id = await seedRectangle(page);
    const bad = path.join(REVIEW_DIR, 'bad.json');
    fs.writeFileSync(bad, '{oops');
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /^AirCAD/ }).click();
    await page.getByRole('button', { name: /Open sketch/ }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles(bad);
    await expect(page.locator('.toast')).toContainText(/JSON|valid/i);
    expect(await page.evaluate((entityId) => (window as any).aircad.sketch.get(entityId), id)).not.toBeNull();
  });
});
