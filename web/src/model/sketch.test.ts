import { describe, expect, it } from 'vitest';
import { makeRect, rectFrame, Sketch } from './sketch';
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
});
