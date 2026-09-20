import { describe, expect, it } from 'vitest';
import {
  loadLayoutPrefs,
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
