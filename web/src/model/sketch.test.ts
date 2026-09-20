import { describe, expect, it } from 'vitest';
import { makeRect, rectFrame, Sketch, type EntityInput } from './sketch';
import { v3 } from './vec';

const floor = (): [ReturnType<typeof v3>, ReturnType<typeof v3>, ReturnType<typeof v3>, ReturnType<typeof v3>] =>
  makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000);

describe('Sketch', () => {
  it('adds entities with stable ids and emits change events', () => {
    const sketch = new Sketch();
    const reasons: string[] = [];
    sketch.onChange((reason) => reasons.push(reason));
    const line = sketch.addEntity({ type: 'line', a: v3(0, 0, 0), b: v3(100, 0, 0) });
    const rect = sketch.addEntity({ type: 'rect', corners: floor() });
    expect(line.id).toBe('e1');
    expect(rect.id).toBe('e2');
    expect(sketch.all.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(reasons).toEqual(['add line', 'add rect']);
  });

  it('undoes and redoes add, delete, replace and clear in order', () => {
    const sketch = new Sketch();
    const line = sketch.addEntity({ type: 'line', a: v3(0, 0, 0), b: v3(100, 0, 0) });
    sketch.addEntity({ type: 'rect', corners: floor() });
    sketch.replaceEntity(line.id, { type: 'line', a: v3(0, 0, 0), b: v3(500, 0, 0) });
    sketch.removeEntity(line.id);
    expect(sketch.all.map((e) => e.id)).toEqual(['e2']);

    expect(sketch.undo()).toMatch(/delete/);
    expect(sketch.all.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect((sketch.get('e1') as { b: { x: number } }).b.x).toBe(500);

    expect(sketch.undo()).toMatch(/edit/);
    expect((sketch.get('e1') as { b: { x: number } }).b.x).toBe(100);

    expect(sketch.redo()).toMatch(/edit/);
    expect((sketch.get('e1') as { b: { x: number } }).b.x).toBe(500);

    sketch.clear();
    expect(sketch.size).toBe(0);
    sketch.undo();
    expect(sketch.size).toBe(2);
    expect(sketch.canRedo).toBe(true);

    // A new mutation invalidates the redo stack.
    sketch.addEntity({ type: 'line', a: v3(0, 0, 0), b: v3(0, 0, 10) });
    expect(sketch.canRedo).toBe(false);
    expect(sketch.redo()).toBeNull();
  });

  it('reports vertices, midpoints, segments and bounding box', () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'rect', corners: floor() });
    sketch.addEntity({ type: 'line', a: v3(0, 0, 0), b: v3(0, 0, 2500) });
    expect(sketch.vertices()).toHaveLength(6);
    expect(sketch.midpoints()).toHaveLength(5);
    expect(sketch.segments()).toHaveLength(5);
    expect(sketch.boundingBox()).toEqual({ min: v3(0, 0, 0), max: v3(4000, 3000, 2500) });
    expect(sketch.center()).toEqual(v3(2000, 1500, 1250));
    expect(new Sketch().center()).toEqual(v3(0, 0, 0));
  });

  it('serialises and restores entities', () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'rect', corners: floor() });
    sketch.addEntity({ type: 'line', a: v3(1, 2, 3), b: v3(4, 5, 6) });
    const restored = Sketch.fromJSON(JSON.parse(sketch.serialize()));
    expect(restored.toJSON()).toEqual(sketch.toJSON());
    const added = restored.addEntity({ type: 'line', a: v3(0, 0, 0), b: v3(1, 1, 1) });
    expect(added.id).toBe('e3');
  });

  it('rejects non-finite coordinates', () => {
    const sketch = new Sketch();
    expect(() => sketch.addEntity({ type: 'line', a: v3(0, 0, 0), b: v3(Number.NaN, 0, 0) })).toThrow();
    expect(sketch.size).toBe(0);
  });

  it('derives a rectangle frame from its corners', () => {
    const frame = rectFrame({ id: 'r', type: 'rect', corners: makeRect(v3(10, 20, 0), v3(1, 0, 0), v3(0, 0, 1), 400, 250) });
    expect(frame.width).toBeCloseTo(400);
    expect(frame.height).toBeCloseTo(250);
    expect(frame.uDir).toEqual(v3(1, 0, 0));
    expect(frame.vDir).toEqual(v3(0, 0, 1));
  });

  it('replaces several entities atomically with one event and exact undo/redo', () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'rect', corners: floor() });
    sketch.addEntity({ type: 'line', a: v3(4000, 0, 0), b: v3(7000, 0, 0) });
    sketch.addEntity({ type: 'line', a: v3(7000, 0, 0), b: v3(7000, 3000, 0) });
    const reasons: string[] = [];
    sketch.onChange((reason) => reasons.push(reason));

    const added = sketch.replaceEntities(
      ['e2', 'e3'],
      [{ type: 'rect', corners: makeRect(v3(4000, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 3000, 3000) }],
      'complete rectangle',
    );
    expect(added).toHaveLength(1);
    expect(added[0].id).toBe('e4');
    expect(sketch.all.map((entity) => entity.id)).toEqual(['e1', 'e4']);
    expect(reasons).toEqual(['complete rectangle']);

    sketch.undo();
    expect(sketch.all.map((entity) => entity.id)).toEqual(['e1', 'e2', 'e3']);
    expect((sketch.get('e2') as { b: { x: number } }).b.x).toBe(7000);
    sketch.redo();
    expect(sketch.all.map((entity) => entity.id)).toEqual(['e1', 'e4']);
    expect(sketch.get('e4')?.type).toBe('rect');
  });

  it('validates every replacement id and input before mutating', () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'line', a: v3(0, 0, 0), b: v3(100, 0, 0) });
    expect(() =>
      sketch.replaceEntities(['e1', 'missing'], [{ type: 'line', a: v3(0, 0, 0), b: v3(5, 0, 0) }], 'x'),
    ).toThrow('entity vanished');
    expect(() =>
      sketch.replaceEntities(['e1'], [{ type: 'line', a: v3(0, 0, 0), b: v3(Number.NaN, 0, 0) }], 'x'),
    ).toThrow();
    expect(sketch.all.map((entity) => entity.id)).toEqual(['e1']);
    expect(sketch.undo()).toBe('add line');
    expect(sketch.canUndo).toBe(false);
  });
});

describe('Sketch.replaceEntities', () => {
  it('replaces multiple entities with stable IDs in one event and undo step', () => {
    const sketch = new Sketch();
    const a = sketch.addEntity({ type: 'rect', corners: floor() });
    const b = sketch.addEntity({ type: 'rect', corners: makeRect(v3(6000, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 400, 300) });
    const untouched = sketch.addEntity({ type: 'line', a: v3(0, 0, 0), b: v3(0, 0, 20) });
    const before = sketch.serialize();
    const reasons: string[] = [];
    sketch.onChange((reason) => reasons.push(reason));
    const inputs: (EntityInput & { id: string })[] = [
      { id: a.id, type: 'extrusion', corners: floor(), depth: 100 },
      { id: b.id, type: 'extrusion', corners: makeRect(v3(6000, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 400, 300), depth: -200 },
    ];
    expect(sketch.replaceEntities(inputs, 'extrude 2 shapes')).toHaveLength(2);
    expect(reasons).toEqual(['extrude 2 shapes']);
    expect(sketch.all.map((entity) => entity.id)).toEqual([a.id, b.id, untouched.id]);
    expect(sketch.get(untouched.id)).toBe(untouched);
    const after = sketch.serialize();
    expect(sketch.undo()).toBe('extrude 2 shapes');
    expect(sketch.serialize()).toBe(before);
    expect(sketch.redo()).toBe('extrude 2 shapes');
    expect(sketch.serialize()).toBe(after);
    if (inputs[0].type === 'extrusion') inputs[0].corners[0].x = 999;
    expect(sketch.serialize()).toBe(after);
  });

  it('rejects missing, duplicate, and invalid replacements without partial edits or history', () => {
    const sketch = new Sketch();
    const a = sketch.addEntity({ type: 'rect', corners: floor() });
    const b = sketch.addEntity({ type: 'rect', corners: floor() });
    const before = sketch.serialize();
    const first = { id: a.id, type: 'extrusion' as const, corners: floor(), depth: 100 };
    const second = { ...first, id: b.id };
    const reasons: string[] = [];
    sketch.onChange((reason) => reasons.push(reason));
    expect(sketch.replaceEntities([first, { ...second, id: 'missing' }])).toBeNull();
    expect(sketch.replaceEntities([first, first])).toBeNull();
    expect(() => sketch.replaceEntities([first, { ...second, depth: NaN }])).toThrow();
    expect(sketch.replaceEntities([])).toEqual([]);
    expect(sketch.serialize()).toBe(before);
    expect(reasons).toEqual([]);
    expect(sketch.undo()).toBe('add rect');
  });
});
