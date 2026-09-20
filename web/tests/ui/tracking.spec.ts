import path from 'node:path';
import { test, expect, webcamSnapshot, oakSnapshot, statusMessage, keycapMessage } from './fixtures';
import type { Page } from '@playwright/test';

const REVIEW_DIR = path.resolve('test-results/review');

const inputButton = (page: Page) => page.getByRole('button', { name: /^Input: / });
const inputPanel = (page: Page) => page.locator('#ws-tab-input');
const panelStatus = (page: Page) => inputPanel(page).locator('.input-panel__status-row .input-panel__status');
const pip = (page: Page) => page.locator('.pip');
const statusRight = (page: Page) => page.locator('.ws-status__right');

async function openInputTab(page: Page, name: string): Promise<void> {
  // The command-bar "Input: …" button opens the inspector on the Input tab.
  await expect(inputButton(page)).toHaveText(`Input: ${name}`);
  await inputButton(page).click();
  await expect(inputPanel(page)).toBeVisible();
}

async function seedRectangle(page: Page): Promise<void> {
  await page.evaluate(() => {
    const result = (window as any).aircad.commands.addRect([
      { x: 0, y: 0, z: 0 },
      { x: 4000, y: 0, z: 0 },
      { x: 4000, y: 3000, z: 0 },
      { x: 0, y: 3000, z: 0 },
    ]);
    if (!result.ok) throw new Error(`seed failed: ${result.error}`);
  });
}

/** Space-hold a live line so the voice panel can capture it; the Speak button is then pointer-operated. */
async function beginLiveLine(page: Page): Promise<void> {
  const host = await page.locator('.viewport').boundingBox();
  expect(host).not.toBeNull();
  await page.locator('.viewport').focus();
  await page.mouse.move(host!.x + 120, host!.y + 120);
  await page.keyboard.down('Space');
  await page.mouse.move(host!.x + 420, host!.y + 120);
}

test.describe('input tracking', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('mouse source: quiet status, hidden camera slot', async ({ page }) => {
    await page.goto('/');
    await openInputTab(page, 'Mouse');

    // The camera slot collapses entirely in mouse mode — no black card.
    await expect(pip(page)).toBeHidden();

    const status = panelStatus(page);
    await expect(status).toHaveText('Mouse input active');
    await expect(status).toHaveAttribute('data-tone', 'neutral');
    await expect(page.getByRole('button', { name: 'Retry' })).toBeHidden();

    // Status bar input health is quiet — no warn/error tone.
    await expect(statusRight(page)).toContainText('Mouse input active');
    await expect(statusRight(page)).toHaveAttribute('data-tone', 'muted');

    await page.screenshot({ path: path.join(REVIEW_DIR, 'input-mouse.png') });
  });

  test('mouse mode keeps the camera slot hidden and explains why', async ({ page }) => {
    await page.goto('/');
    await expect(inputButton(page)).toHaveText('Input: Mouse');
    await page.locator('.viewport').focus();
    await page.keyboard.press('p');
    await expect(pip(page)).toBeHidden();

    await page.getByRole('button', { name: 'View' }).click();
    const item = page.getByRole('button', { name: /Camera preview/ });
    await expect(item).toBeDisabled();
    await expect(item).toHaveAttribute('title', 'Camera preview needs a camera input');
  });

  test('a failed config change snaps the source select back and keeps the sketch', async ({
    page,
    tracker,
  }) => {
    await page.goto('/');
    await openInputTab(page, 'Mouse');
    await seedRectangle(page);

    tracker.failNextPost(409, 'Camera in use');
    const select = inputPanel(page).getByLabel('Source');
    await select.selectOption('webcam');

    await expect(page.locator('.toast.toast--error')).toContainText('Camera in use');
    await expect(select).toHaveValue('none');
    expect(await page.evaluate(() => (window as any).aircad.sketch.size)).toBe(1);
    await expect(inputButton(page)).toHaveText('Input: Mouse');
  });

  test('a successful config change updates the source and command bar', async ({ page }) => {
    await page.goto('/');
    await openInputTab(page, 'Mouse');
    await inputPanel(page).getByLabel('Source').selectOption('webcam');
    await expect(inputPanel(page).getByLabel('Source')).toHaveValue('webcam');
    await expect(inputButton(page)).toHaveText('Input: Webcam');
  });
});

test.describe('webcam source', () => {
  test.use({ viewport: { width: 1440, height: 900 }, trackerSnapshot: webcamSnapshot });

  test('camera preview paints the dot from its own frame, not the newest cursor packet', async ({ page, tracker }) => {
    await page.goto('/');
    await openInputTab(page, 'Webcam');
    tracker.send(statusMessage('ready'));
    const jpeg = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 384; canvas.height = 288;
      const context = canvas.getContext('2d')!;
      context.fillStyle = 'black'; context.fillRect(0, 0, 384, 288);
      return canvas.toDataURL('image/jpeg').split(',')[1];
    });
    const captured = keycapMessage(1000);
    captured.keycaps[0].center = [160, 240];
    tracker.send({ type: 'thumb', jpeg, w: 384, h: 288, keycapFrame: captured });
    const newer = keycapMessage(1033);
    newer.keycaps[0].center = [480, 240];
    tracker.send(newer);
    const greenAt = (x: number) => page.locator('.pip canvas').evaluate((node, px) => {
      const pixel = (node as HTMLCanvasElement).getContext('2d')!.getImageData(px, 144, 1, 1).data;
      return pixel[1];
    }, x);
    await expect.poll(() => greenAt(96)).toBeGreaterThan(200);
    expect(await greenAt(288)).toBeLessThan(20);
    await page.screenshot({ path: path.join(REVIEW_DIR, 'input-keycap-paired.png') });
    tracker.send({ type: 'thumb', jpeg, w: 384, h: 288, keycapFrame: { ...newer, keycaps: [] } });
    await expect.poll(() => greenAt(96)).toBeLessThan(20);
  });

  test('holding Space makes one undoable line across a short same-target dropout', async ({ page, tracker }) => {
    await page.goto('/');
    await openInputTab(page, 'Webcam');
    tracker.send(statusMessage('ready'));
    await page.locator('.viewport').focus();
    await page.keyboard.press('1');
    await page.waitForTimeout(250);
    tracker.send(keycapMessage(1000));
    await expect(panelStatus(page)).toHaveText('Tracking');
    await page.keyboard.down('Space');
    const move = keycapMessage(1033);
    move.keycaps[0].center = [360, 240];
    tracker.send(move);
    await page.waitForTimeout(30);
    tracker.send({ ...keycapMessage(1066), keycaps: [] });
    await page.waitForTimeout(70);
    expect(await page.evaluate(() => (window as any).aircad.sketch.size)).toBe(0);
    const recovered = keycapMessage(1133);
    recovered.keycaps[0].center = [390, 240];
    tracker.send(recovered);
    await page.waitForTimeout(30);
    await page.keyboard.up('Space');
    await expect.poll(() => page.evaluate(() => (window as any).aircad.sketch.size)).toBe(1);
    await page.evaluate(() => (window as any).aircad.commands.undo());
    expect(await page.evaluate(() => (window as any).aircad.sketch.size)).toBe(0);
  });

  test('brief startup dropouts stay quiet; sustained loss warns and recovery clears it', async ({ page, tracker }) => {
    await page.goto('/');
    await openInputTab(page, 'Webcam');
    tracker.send(statusMessage('ready'));
    tracker.send(keycapMessage(1));
    await expect(panelStatus(page)).toHaveText('Tracking');
    await page.evaluate(() => {
      const notices: string[] = [];
      (window as any).trackingNotices = notices;
      new MutationObserver(() => notices.push(document.querySelector('.viewport-notice')!.textContent ?? ''))
        .observe(document.querySelector('.viewport-notice')!, { childList: true, subtree: true });
    });
    for (let i = 0; i < 4; i++) {
      tracker.send({ ...keycapMessage(2 + i * 2), keycaps: [] });
      await page.waitForTimeout(60);
      tracker.send(keycapMessage(3 + i * 2));
      await page.waitForTimeout(60);
    }
    expect(await page.evaluate(() => (window as any).trackingNotices.some((text: string) => text.includes('Tracking paused')))).toBe(false);
    tracker.send({ ...keycapMessage(20), keycaps: [] });
    await expect(page.locator('.viewport-notice')).toContainText('Tracking paused');
    await expect(panelStatus(page)).toHaveText('Keycap lost — show the green keycap');
    tracker.send(keycapMessage(21));
    await expect(page.locator('.viewport-notice')).not.toContainText('Tracking paused');
    await expect(panelStatus(page)).toHaveText('Tracking');
  });

  test('status follows camera state through error, tracking, and offline', async ({ page, tracker }) => {
    await page.goto('/');
    await openInputTab(page, 'Webcam');
    const status = panelStatus(page);

    // Seeded geometry survives camera trouble.
    await seedRectangle(page);

    tracker.send(statusMessage('starting'));
    await expect(status).toHaveText('Camera starting…');

    tracker.send(statusMessage('ready'));
    await expect(status).toHaveText('Show the green keycap to track');

    tracker.send(statusMessage('error', 'device busy'));
    await expect(status).toHaveText('Camera unavailable: device busy');
    await expect(status).toHaveAttribute('data-tone', 'error');
    await expect(inputPanel(page).getByRole('button', { name: 'Retry' })).toBeVisible();
    // One error toast — identical reports deduplicate.
    await expect(page.locator('.toast.toast--error')).toHaveCount(1);
    expect(await page.evaluate(() => (window as any).aircad.sketch.size)).toBe(1);
    await page.screenshot({ path: path.join(REVIEW_DIR, 'input-webcam-error.png') });

    tracker.send(statusMessage('ready'));
    tracker.send(keycapMessage(1));
    await expect(status).toHaveText('Tracking');
    await expect(status).toHaveAttribute('data-tone', 'ok');

    tracker.close();
    await expect(status).toHaveText('Tracker offline — reconnecting…');
    await expect(status).toHaveAttribute('data-tone', 'warn');
  });

  test('P toggles the camera preview and the View menu item follows', async ({ page }) => {
    await page.goto('/');
    await expect(inputButton(page)).toHaveText('Input: Webcam');
    // The slot shows a neutral status panel before any frame arrives.
    await expect(pip(page)).toBeVisible();
    await expect(pip(page).locator('.pip__empty')).toBeVisible();

    await page.locator('.viewport').focus();
    await page.keyboard.press('p');
    await expect(pip(page)).toBeHidden();

    await page.getByRole('button', { name: 'View' }).click();
    await expect(page.getByRole('button', { name: /Camera preview/ })).toHaveAttribute('aria-pressed', 'false');

    // Collapse the inspector; showing the preview again reopens it.
    await page.getByLabel('Inspector panel', { exact: true }).click();
    await page.locator('.viewport').focus();
    await page.keyboard.press('p');
    await expect(pip(page)).toBeVisible();
    await expect(page.locator('.ws-panel', { has: page.locator('.ws-inspector__body') })).toBeVisible();
  });
});

test.describe('depth camera source', () => {
  test.use({ viewport: { width: 1440, height: 900 }, trackerSnapshot: oakSnapshot(true) });

  test('shows depth controls and the origin-needed status', async ({ page }) => {
    await page.goto('/');
    await openInputTab(page, 'Depth camera');

    const status = panelStatus(page);
    await expect(status).toHaveText('Origin needed — press Set origin');
    await expect(status).toHaveAttribute('data-tone', 'warn');

    await expect(inputPanel(page).getByLabel('Target')).toBeEnabled();
    await expect(inputPanel(page).getByLabel('Mapping scale')).toBeEnabled();
    await expect(inputPanel(page).getByRole('button', { name: 'Set origin (O)' })).toBeEnabled();
    await expect(page.locator('.viewport-notice')).toContainText('origin');

    await page.screenshot({ path: path.join(REVIEW_DIR, 'input-depth-origin.png') });
  });
});

test.describe('depth camera without DepthAI', () => {
  test.use({ viewport: { width: 1440, height: 900 }, trackerSnapshot: oakSnapshot(false) });

  test('disables depth controls with the install reason', async ({ page }) => {
    await page.goto('/');
    await openInputTab(page, 'Depth camera');

    const target = inputPanel(page).getByLabel('Target');
    await expect(target).toBeDisabled();
    await expect(target).toHaveAttribute('title', 'DepthAI is not installed — pip install -r requirements-depth.txt');
    await expect(inputPanel(page)).toContainText('DepthAI is not installed — pip install -r requirements-depth.txt');
    await expect(inputPanel(page).getByRole('button', { name: 'Set origin (O)' })).toBeDisabled();
  });
});

test.describe('voice feedback', () => {
  test.use({ viewport: { width: 1280, height: 720 }, fakeSpeech: true });

  test('pointer capture shows listening and success without covering the triad', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.voice-control')).toBeVisible();
    const voice = page.locator('.voice-control');
    const box = await voice.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(112);
    expect(box!.width).toBeLessThanOrEqual(420);

    await beginLiveLine(page);
    await page.locator('.voice-control__record').click();
    await expect(page.locator('.voice-control__status')).toContainText('Listening');
    await page.screenshot({ path: path.join(REVIEW_DIR, 'voice-listening-1280x720.png') });
    await page.evaluate(() => {
      const speech = (window as any).__aircadSpeech;
      if (!speech) throw new Error('fake speech was not started');
      speech.emit(false, '500 millimetres');
    });
    await expect(page.locator('.voice-control__status')).toHaveText('Line — 500 mm');
    await page.screenshot({ path: path.join(REVIEW_DIR, 'voice-success-1280x720.png') });
  });

  test('long error text wraps inside the dock', async ({ page }) => {
    await page.goto('/');
    await beginLiveLine(page);
    await page.locator('.voice-control__record').click();
    await expect(page.locator('.voice-control__status')).toContainText('Listening');
    await page.evaluate(() => {
      const speech = (window as any).__aircadSpeech;
      if (!speech) throw new Error('fake speech was not started');
      speech.emit(false, 'please make this wall a great deal taller than it already is');
    });
    await page.locator('.voice-control__record').click();
    const status = page.locator('.voice-control__status');
    await expect(status).toContainText('Say one positive distance');
    const box = await status.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(420);
    await page.screenshot({ path: path.join(REVIEW_DIR, 'voice-error-1280x720.png') });
  });
});

test.describe('voice feedback at 1440x900', () => {
  test.use({ viewport: { width: 1440, height: 900 }, fakeSpeech: true });

  test('voice dock stays clear of the triad at the larger review size', async ({ page }) => {
    await page.goto('/');
    const voice = page.locator('.voice-control');
    await expect(voice).toBeVisible();
    const box = await voice.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(112);
    expect(box!.width).toBeLessThanOrEqual(420);
    await page.screenshot({ path: path.join(REVIEW_DIR, 'voice-idle-1440x900.png') });
  });
});
