import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeRect, Sketch, type SketchJSON } from '../model/sketch';
import { v3 } from '../model/vec';
import {
  chooseSketchFile,
  downloadSketchFile,
  MAX_PROFILE_CORNERS,
  MAX_SKETCH_BYTES,
  MAX_SKETCH_ENTITIES,
  MAX_STORED_POINTS,
  parseSketchFile,
  SKETCH_DOWNLOAD_NAME,
} from './sketch-files';

const corners = makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000);

function mixedDocument(): SketchJSON {
  const sketch = new Sketch();
  sketch.addEntity({ type: 'line', a: v3(0, 0, 0), b: v3(4000, 0, 0) });
  sketch.addEntity({ type: 'rect', corners });
  sketch.addEntity({ type: 'extrusion', corners, depth: -12.5 });
  sketch.addEntity({ type: 'polygon', corners: [v3(0, 0, 0), v3(400, 0, 0), v3(100, 300, 0)] });
  sketch.addEntity({ type: 'triangle', corners: [v3(0, 0, 0), v3(300, 0, 0), v3(0, 300, 0)] });
  sketch.addEntity({ type: 'prism', corners: [v3(0, 0, 2500), v3(4000, 0, 2500), v3(2000, 0, 4000)], depth: 3000 });
  sketch.addEntity({ type: 'circle', center: v3(0, 0, 0), normal: v3(0, 0, 1), radius: 50 });
  return sketch.toJSON();
}

describe('parseSketchFile', () => {
  it('round-trips every native entity type including signed depths and circles', () => {
    const data = mixedDocument();
    const parsed = parseSketchFile(JSON.stringify(data));
    expect(parsed).toEqual(data);
    expect(parsed.entities.some((entity) => entity.type === 'circle')).toBe(true);
    const extrusion = parsed.entities.find((entity) => entity.type === 'extrusion');
    expect(extrusion && extrusion.type === 'extrusion' ? extrusion.depth : null).toBe(-12.5);
  });

  it('does not serialize derived loops and rejects sourceIds records', () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'line', a: v3(0, 0, 0), b: v3(100, 0, 0) });
    sketch.addEntity({ type: 'line', a: v3(100, 0, 0), b: v3(100, 100, 0) });
    sketch.addEntity({ type: 'line', a: v3(100, 100, 0), b: v3(0, 100, 0) });
    sketch.addEntity({ type: 'line', a: v3(0, 100, 0), b: v3(0, 0, 0) });
    const json = sketch.toJSON();
    expect(json.entities.every((entity) => !('sourceIds' in entity))).toBe(true);
    expect(() => parseSketchFile(JSON.stringify({
      version: 1,
      units: 'mm',
      entities: [{ id: 'loop', type: 'polygon', corners: [v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0)], sourceIds: ['e1'] }],
    }))).toThrow(/Derived loop/);
  });

  it('rejects unsupported envelopes, duplicate ids, and non-finite values', () => {
    expect(() => parseSketchFile('[]')).toThrow(/JSON object/);
    expect(() => parseSketchFile(JSON.stringify({ version: 2, units: 'mm', entities: [] }))).toThrow(/version/);
    expect(() => parseSketchFile(JSON.stringify({ version: 1, units: 'cm', entities: [] }))).toThrow(/millimetres/);
    expect(() => parseSketchFile(JSON.stringify({ version: 1, units: 'mm', entities: [{ id: 'e1', type: 'mystery', a: v3(0, 0, 0), b: v3(1, 0, 0) }] }))).toThrow(/unsupported type/);
    expect(() => parseSketchFile(JSON.stringify({
      version: 1,
      units: 'mm',
      entities: [
        { id: 'e1', type: 'line', a: v3(0, 0, 0), b: v3(1, 0, 0) },
        { id: 'e1', type: 'line', a: v3(0, 0, 0), b: v3(2, 0, 0) },
      ],
    }))).toThrow(/Duplicate/);
    expect(() => parseSketchFile(JSON.stringify({
      version: 1,
      units: 'mm',
      entities: [{ id: 'e1', type: 'line', a: v3(0, 0, 0), b: { x: Number.NaN, y: 0, z: 0 } }],
    }))).toThrow(/non-finite/);
  });

  it('rejects over-limit files without mutating a live sketch', () => {
    const original = new Sketch();
    original.addEntity({ type: 'line', a: v3(0, 0, 0), b: v3(10, 0, 0) });
    const snapshot = original.toJSON();
    const huge = 'x'.repeat(MAX_SKETCH_BYTES + 1);
    expect(() => parseSketchFile(huge)).toThrow(/MiB/);
    expect(() => parseSketchFile(JSON.stringify({
      version: 1,
      units: 'mm',
      entities: Array.from({ length: MAX_SKETCH_ENTITIES + 1 }, (_, index) => ({
        id: `e${index + 1}`,
        type: 'line',
        a: v3(0, 0, 0),
        b: v3(1, 0, 0),
      })),
    }))).toThrow(/too many entities/);
    expect(() => parseSketchFile(JSON.stringify({
      version: 1,
      units: 'mm',
      entities: [{
        id: 'e1',
        type: 'polygon',
        corners: Array.from({ length: MAX_PROFILE_CORNERS + 1 }, (_, index) => v3(index, 0, 0)),
      }],
    }))).toThrow(/too many corners/);
    expect(original.toJSON()).toEqual(snapshot);
    expect(original.addEntity({ type: 'line', a: v3(0, 0, 0), b: v3(0, 1, 0) }).id).toBe('e2');
  });

  it('allows an empty valid document', () => {
    expect(parseSketchFile(JSON.stringify({ version: 1, units: 'mm', entities: [] }))).toEqual({
      version: 1,
      units: 'mm',
      entities: [],
    });
  });
});

describe('downloadSketchFile', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('downloads canonical JSON and revokes the object URL', () => {
    const clicks: string[] = [];
    const removed: unknown[] = [];
    const url = 'blob:sketch';
    const create = vi.fn(() => url);
    const revoke = vi.fn();
    const anchor = {
      href: '',
      download: '',
      click: () => clicks.push(anchor.download),
      remove: () => removed.push(anchor),
    };
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
    vi.stubGlobal('document', {
      createElement: () => anchor,
      body: { appendChild: vi.fn() },
    });
    downloadSketchFile(mixedDocument());
    expect(create).toHaveBeenCalled();
    expect(anchor.download).toBe(SKETCH_DOWNLOAD_NAME);
    expect(clicks).toEqual([SKETCH_DOWNLOAD_NAME]);
    expect(removed).toHaveLength(1);
    expect(revoke).toHaveBeenCalledWith(url);
  });
});

describe('chooseSketchFile', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns null when the picker is cancelled', async () => {
    const input: {
      type: string;
      accept: string;
      value: string;
      files: File[] | null;
      listeners: Record<string, () => void>;
      click: () => void;
      remove: ReturnType<typeof vi.fn>;
      addEventListener: (type: string, listener: () => void) => void;
    } = {
      type: '',
      accept: '',
      value: 'previous',
      files: null,
      listeners: {},
      click() {
        this.listeners.cancel?.();
      },
      remove: vi.fn(),
      addEventListener(type, listener) {
        this.listeners[type] = listener;
      },
    };
    vi.stubGlobal('document', {
      createElement: () => input,
      body: { appendChild: vi.fn() },
    });
    await expect(chooseSketchFile()).resolves.toBeNull();
    expect(input.value).toBe('');
    expect(input.remove).toHaveBeenCalled();
  });
});

describe('resource limits helper', () => {
  it('exports the documented caps', () => {
    expect(MAX_SKETCH_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_SKETCH_ENTITIES).toBe(2000);
    expect(MAX_PROFILE_CORNERS).toBe(256);
    expect(MAX_STORED_POINTS).toBe(10_000);
  });
});
