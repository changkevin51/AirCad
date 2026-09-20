import { describe, expect, it } from 'vitest';
import {
  cycleTargets,
  loadLayoutPrefs,
  resolveEffectiveLayout,
  resolvePanelVisibility,
  saveLayoutPrefs,
  LAYOUT_STORAGE_KEY,
  type WorkspaceLayout,
} from './workspace';

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
  };
}

const prefs: WorkspaceLayout = { browserVisible: false, inspectorVisible: true, inspectorTab: 'input' };

describe('layout preferences', () => {
  it('round-trips through storage under the versioned key', () => {
    const storage = fakeStorage();
    saveLayoutPrefs(prefs, storage);
    expect(storage.getItem(LAYOUT_STORAGE_KEY)).toBe(JSON.stringify(prefs));
    expect(loadLayoutPrefs(storage)).toEqual(prefs);
  });

  it('falls back to defaults on missing or corrupt data', () => {
    expect(loadLayoutPrefs(fakeStorage())).toEqual({
      browserVisible: true,
      inspectorVisible: true,
      inspectorTab: 'properties',
    });
    expect(loadLayoutPrefs(fakeStorage({ [LAYOUT_STORAGE_KEY]: '{oops' }))).toEqual({
      browserVisible: true,
      inspectorVisible: true,
      inspectorTab: 'properties',
    });
  });

  it('sanitizes partial and wrong-typed values', () => {
    const storage = fakeStorage({ [LAYOUT_STORAGE_KEY]: JSON.stringify({ inspectorVisible: false, inspectorTab: 'bogus' }) });
    expect(loadLayoutPrefs(storage)).toEqual({
      browserVisible: true,
      inspectorVisible: false,
      inspectorTab: 'properties',
    });
  });

  it('never throws when storage fails', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(() => saveLayoutPrefs(prefs, broken)).not.toThrow();
    expect(loadLayoutPrefs(broken)).toEqual({
      browserVisible: true,
      inspectorVisible: true,
      inspectorTab: 'properties',
    });
  });
});

describe('resolvePanelVisibility', () => {
  const desktop: WorkspaceLayout = { browserVisible: true, inspectorVisible: true, inspectorTab: 'properties' };

  it('uses preferences verbatim at desktop widths', () => {
    expect(resolvePanelVisibility(desktop, 'normal', null)).toEqual({ browserVisible: true, inspectorVisible: true });
    expect(resolvePanelVisibility(prefs, 'normal', null)).toEqual({ browserVisible: false, inspectorVisible: true });
  });

  it('collapses the browser by default in the compact band', () => {
    expect(resolvePanelVisibility(desktop, 'compact', null)).toEqual({ browserVisible: false, inspectorVisible: true });
  });

  it('keeps only one side open in the compact band', () => {
    expect(resolvePanelVisibility(desktop, 'compact', 'browser')).toEqual({ browserVisible: true, inspectorVisible: false });
    expect(resolvePanelVisibility(desktop, 'compact', 'inspector')).toEqual({ browserVisible: false, inspectorVisible: true });
  });

  it('starts with no drawer open in the narrow band and opens one at a time', () => {
    expect(resolvePanelVisibility(desktop, 'narrow', null)).toEqual({ browserVisible: false, inspectorVisible: false });
    expect(resolvePanelVisibility(desktop, 'narrow', 'browser')).toEqual({ browserVisible: true, inspectorVisible: false });
    expect(resolvePanelVisibility(desktop, 'narrow', 'inspector')).toEqual({ browserVisible: false, inspectorVisible: true });
  });
});

describe('presentation layout', () => {
  const desktop: WorkspaceLayout = { browserVisible: true, inspectorVisible: true, inspectorTab: 'input' };

  it('hides both panels only while presenting and keeps the inspector tab', () => {
    expect(resolveEffectiveLayout(desktop, 'normal', null, false)).toEqual({
      browserVisible: true,
      inspectorVisible: true,
      inspectorTab: 'input',
    });
    expect(resolveEffectiveLayout(desktop, 'normal', null, true)).toEqual({
      browserVisible: false,
      inspectorVisible: false,
      inspectorTab: 'input',
    });
  });

  it('restores the current band visibility when presentation ends', () => {
    for (const open of [null, 'browser', 'inspector'] as const) {
      expect(resolveEffectiveLayout(desktop, 'compact', open, true)).toEqual({
        browserVisible: false,
        inspectorVisible: false,
        inspectorTab: 'input',
      });
      expect(resolveEffectiveLayout(desktop, 'compact', open, false)).toEqual({
        ...resolvePanelVisibility(desktop, 'compact', open),
        inspectorTab: 'input',
      });
      expect(resolveEffectiveLayout(desktop, 'narrow', open, false)).toEqual({
        ...resolvePanelVisibility(desktop, 'narrow', open),
        inspectorTab: 'input',
      });
    }
    // A width change during presentation exits into the new band, not the old one.
    expect(resolveEffectiveLayout(desktop, 'narrow', null, false)).toEqual({
      browserVisible: false,
      inspectorVisible: false,
      inspectorTab: 'input',
    });
    expect(resolveEffectiveLayout(desktop, 'narrow', 'browser', false).browserVisible).toBe(true);
  });
});

describe('cycleTargets', () => {
  it('cycles app bar → browser → viewport → inspector, skipping hidden panels', () => {
    expect(cycleTargets(false, { browserVisible: true, inspectorVisible: true })).toEqual([
      'appBar',
      'browser',
      'viewport',
      'inspector',
    ]);
    expect(cycleTargets(false, { browserVisible: false, inspectorVisible: true })).toEqual(['appBar', 'viewport', 'inspector']);
    expect(cycleTargets(false, { browserVisible: true, inspectorVisible: false })).toEqual(['appBar', 'browser', 'viewport']);
  });

  it('keeps only the view strip and viewport focusable while presenting', () => {
    expect(cycleTargets(true, { browserVisible: true, inspectorVisible: true })).toEqual(['viewControls', 'viewport']);
    expect(cycleTargets(true, { browserVisible: false, inspectorVisible: false })).toEqual(['viewControls', 'viewport']);
  });
});

describe('presentation layout', () => {
  const desktop: WorkspaceLayout = { browserVisible: true, inspectorVisible: true, inspectorTab: 'input' };

  it('collapses both panels without changing the inspector tab', () => {
    expect(resolveEffectiveLayout(desktop, 'normal', null, true)).toEqual({
      browserVisible: false,
      inspectorVisible: false,
      inspectorTab: 'input',
    });
    expect(resolveEffectiveLayout(desktop, 'normal', null, false)).toEqual(desktop);
  });

  it('restores the current responsive band when presentation ends', () => {
    expect(resolveEffectiveLayout(desktop, 'compact', null, true)).toEqual({
      browserVisible: false,
      inspectorVisible: false,
      inspectorTab: 'input',
    });
    expect(resolveEffectiveLayout(desktop, 'compact', null, false)).toEqual({
      browserVisible: false,
      inspectorVisible: true,
      inspectorTab: 'input',
    });
    expect(resolveEffectiveLayout(desktop, 'narrow', 'browser', false)).toEqual({
      browserVisible: true,
      inspectorVisible: false,
      inspectorTab: 'input',
    });
  });

  it('limits F6 cycling to the view strip and viewport while presenting', () => {
    expect(cycleTargets(true, desktop)).toEqual(['viewControls', 'viewport']);
    expect(cycleTargets(false, desktop)).toEqual(['appBar', 'browser', 'viewport', 'inspector']);
    expect(cycleTargets(false, { browserVisible: false, inspectorVisible: false })).toEqual(['appBar', 'viewport']);
  });

  it('does not persist a presentation override through layout storage', () => {
    const storage = fakeStorage();
    saveLayoutPrefs(desktop, storage);
    const presenting = resolveEffectiveLayout(loadLayoutPrefs(storage), 'normal', null, true);
    expect(presenting.browserVisible).toBe(false);
    expect(JSON.parse(storage.getItem(LAYOUT_STORAGE_KEY)!)).toEqual(desktop);
  });
});
