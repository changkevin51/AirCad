import { describe, expect, it } from 'vitest';
import { Commands, parseDimensionSpec } from './commands';
import { makeRect, Sketch, type LineEntity, type RectEntity, type SolidEntity } from './sketch';
import { v3 } from './vec';

describe('parseDimensionSpec', () => {
  it('reads lengths and width x height with optional units', () => {
    expect(parseDimensionSpec('4000')).toEqual({ length: 4000 });
    expect(parseDimensionSpec(' 2.5 m ')).toEqual({ length: 2500 });
    expect(parseDimensionSpec('4000x3000')).toEqual({ width: 4000, height: 3000 });
    expect(parseDimensionSpec('4000 X 3000')).toEqual({ width: 4000, height: 3000 });
    expect(parseDimensionSpec('4 m by 3 m')).toEqual({ width: 4000, height: 3000 });
    expect(parseDimensionSpec('120cm*80cm')).toEqual({ width: 1200, height: 800 });
  });

  it('rejects garbage and non-positive values', () => {
    expect(parseDimensionSpec('')).toBeNull();
    expect(parseDimensionSpec('abc')).toBeNull();
    expect(parseDimensionSpec('0')).toBeNull();
    expect(parseDimensionSpec('-5')).toBeNull();
    expect(parseDimensionSpec('1x2x3')).toBeNull();
  });
});

describe('Commands.setDimension', () => {
  it('sets a line length keeping start and direction', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const added = commands.addLine(v3(100, 100, 0), v3(400, 500, 0));
    expect(added.ok).toBe(true);
    const id = added.ok ? added.entity.id : '';

    const result = commands.setDimension(id, '4000');
    expect(result.ok).toBe(true);
    const line = sketch.get(id) as LineEntity;
    expect(line.a).toEqual(v3(100, 100, 0));
    expect(Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y, line.b.z - line.a.z)).toBeCloseTo(4000);
    // Direction preserved (3:4:0).
    expect((line.b.x - line.a.x) / (line.b.y - line.a.y)).toBeCloseTo(3 / 4);

    expect(commands.setDimension(id, '4000x3000').ok).toBe(false);
    expect(commands.undo()).toMatch(/set length/);
    expect((sketch.get(id) as LineEntity).b).toEqual(v3(400, 500, 0));
  });

  it('resizes a rectangle keeping its origin corner and orientation', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const added = commands.addRect(makeRect(v3(1000, 0, 0), v3(1, 0, 0), v3(0, 0, 1), 900, 700));
    const id = added.ok ? added.entity.id : '';

    const result = commands.setDimension(id, { width: 4000, height: 3000 });
    expect(result.ok).toBe(true);
    const rect = sketch.get(id) as RectEntity;
    expect(rect.corners[0]).toEqual(v3(1000, 0, 0));
    expect(rect.corners[1]).toEqual(v3(5000, 0, 0));
    expect(rect.corners[2]).toEqual(v3(5000, 0, 3000));
    expect(rect.corners[3]).toEqual(v3(1000, 0, 3000));

    expect(commands.setDimension(id, '4000').ok).toBe(false);
    expect(commands.setDimension('nope', '4000').ok).toBe(false);
    expect(commands.setDimension(id, 'banana').ok).toBe(false);
  });

  it('deletes, clears and exports in millimetres', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    commands.addLine(v3(0, 0, 0), v3(0, 0, 10));
    commands.addRect(makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 10, 20));
    expect(commands.exportPayload()).toEqual({
      units: 'mm',
      entities: [
        { type: 'line', points: [[0, 0, 0], [0, 0, 10]] },
        { type: 'rect', points: [[0, 0, 0], [10, 0, 0], [10, 20, 0], [0, 20, 0]] },
      ],
    });
    expect(commands.deleteLast().ok).toBe(true);
    expect(sketch.size).toBe(1);
    expect(commands.clear()).toBe(1);
    expect(commands.deleteLast().ok).toBe(false);
    expect(commands.addLine(v3(1, 1, 1), v3(1, 1, 1)).ok).toBe(false);
  });

  it('sets a line angle in-plane, keeps length, and undoes', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const added = commands.addLine(v3(0, 0, 0), v3(100, 100, 0));
    const id = added.ok ? added.entity.id : '';
    const result = commands.setLineAngle(id, '30', 'XY');
    expect(result.ok).toBe(true);
    const line = sketch.get(id) as LineEntity;
    expect(line.a).toEqual(v3(0, 0, 0));
    expect(Math.hypot(line.b.x, line.b.y, line.b.z)).toBeCloseTo(Math.hypot(100, 100, 0), 6);
    expect((Math.atan2(line.b.y, line.b.x) * 180) / Math.PI).toBeCloseTo(30, 5);
    expect(commands.setLineAngle(id, 'abc', 'XY').ok).toBe(false);
    expect(commands.undo()).toMatch(/set angle/);
    expect((sketch.get(id) as LineEntity).b).toEqual(v3(100, 100, 0));
  });

  it('keeps an arbitrary XYZ line through undo and export', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const added = commands.commitStroke({ type: 'line', a: v3(12, 34, 56), b: v3(78, 90, 123) });
    expect(added.ok).toBe(true);
    const exported = commands.exportPayload().entities[0];
    expect(exported.type).toBe('line');
    if (exported.type === 'line' || exported.type === 'rect' || exported.type === 'extrusion') {
      expect(exported.points).toEqual([[12, 34, 56], [78, 90, 123]]);
    }
    expect(commands.undo()).toMatch(/line/i);
    expect(sketch.size).toBe(0);
    expect(commands.redo()).toMatch(/line/i);
    const line = sketch.last as LineEntity;
    expect(line.a).toEqual(v3(12, 34, 56));
    expect(line.b).toEqual(v3(78, 90, 123));
  });
});

describe('Commands.commitStroke', () => {
  const completedRect = (): [ReturnType<typeof v3>, ReturnType<typeof v3>, ReturnType<typeof v3>, ReturnType<typeof v3>] =>
    [v3(4000, 0, 0), v3(4000, 3000, 0), v3(7000, 3000, 0), v3(7000, 0, 0)];

  it('dispatches to addLine/addRect when no replacements are given', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const line = commands.commitStroke({ type: 'line', a: v3(0, 0, 0), b: v3(100, 0, 0) });
    expect(line.ok).toBe(true);
    const rect = commands.commitStroke({ type: 'rect', corners: completedRect() });
    expect(rect.ok).toBe(true);
    expect(sketch.all.map((entity) => entity.id)).toEqual(['e1', 'e2']);
    expect(commands.commitStroke({ type: 'line', a: v3(0, 0, 0), b: v3(0, 0, 0) }).ok).toBe(false);
  });

  it('commits a completed rectangle and removes the consolidated lines atomically', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    commands.addRect(makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000));
    commands.addLine(v3(4000, 0, 0), v3(7000, 0, 0));
    commands.addLine(v3(7000, 0, 0), v3(7000, 3000, 0));

    const reasons: string[] = [];
    sketch.onChange((reason) => reasons.push(reason));
    const result = commands.commitStroke({ type: 'rect', corners: completedRect() }, ['e2', 'e3']);
    expect(result.ok).toBe(true);
    expect(result.ok && result.entity.id).toBe('e4');
    expect(result.ok && result.message).toMatch(/rectangle/i);
    expect(sketch.all.map((entity) => entity.id)).toEqual(['e1', 'e4']);
    expect(reasons).toEqual(['complete rectangle']);

    commands.undo();
    expect(sketch.all.map((entity) => entity.id)).toEqual(['e1', 'e2', 'e3']);
    commands.redo();
    expect(sketch.all.map((entity) => entity.id)).toEqual(['e1', 'e4']);
  });

  it('fails on unknown replacement ids without history or id allocation', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    commands.addLine(v3(4000, 0, 0), v3(7000, 0, 0));
    const result = commands.commitStroke({ type: 'rect', corners: completedRect() }, ['e1', 'e9']);
    expect(result.ok).toBe(false);
    expect(sketch.all.map((entity) => entity.id)).toEqual(['e1']);
    expect(commands.undo()).toBe('add line');
    const after = commands.addLine(v3(0, 0, 0), v3(5, 0, 0));
    expect(after.ok && after.entity.id).toBe('e2');
  });

  it('rejects invalid or non-rectangle input for replacements', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    commands.addLine(v3(4000, 0, 0), v3(7000, 0, 0));
    expect(commands.commitStroke({ type: 'line', a: v3(0, 0, 0), b: v3(9, 0, 0) }, ['e1']).ok).toBe(false);
    const flat = commands.commitStroke(
      { type: 'rect', corners: [v3(0, 0, 0), v3(0, 0, 0), v3(0, 0, 0), v3(0, 0, 0)] },
      ['e1'],
    );
    expect(flat.ok).toBe(false);
    const nan = commands.commitStroke(
      { type: 'rect', corners: [v3(0, 0, 0), v3(Number.NaN, 0, 0), v3(3, 3, 0), v3(0, 3, 0)] },
      ['e1'],
    );
    expect(nan.ok).toBe(false);
    expect(sketch.all.map((entity) => entity.id)).toEqual(['e1']);
    expect(commands.undo()).toBe('add line');
  });
});

describe('Commands.extrudeMany', () => {
  function setup() {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const corners = makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 400, 300);
    const a = sketch.addEntity({ type: 'rect', corners });
    const other = makeRect(v3(700, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 100, 80);
    const b = sketch.addEntity({ type: 'rect', corners: other });
    const previews: SolidEntity[] = [
      { id: a.id, type: 'extrusion', corners, depth: 100 },
      { id: b.id, type: 'extrusion', corners: other, depth: -200 },
    ];
    return { sketch, commands, previews };
  }

  it('applies mixed box previews atomically and undoes both together', () => {
    const { sketch, commands, previews } = setup();
    const before = sketch.serialize();
    const reasons: string[] = [];
    sketch.onChange((reason) => reasons.push(reason));
    const result = commands.extrudeMany(previews);
    expect(result.ok).toBe(true);
    expect(sketch.all).toEqual(previews);
    expect(reasons).toEqual(['extrude 2 shapes']);
    const after = sketch.serialize();
    expect(commands.undo()).toBe('extrude 2 shapes');
    expect(sketch.serialize()).toBe(before);
    expect(commands.redo()).toBe('extrude 2 shapes');
    expect(sketch.serialize()).toBe(after);
  });

  it('validates every preview and rejects duplicates before any mutation', () => {
    const { sketch, commands, previews } = setup();
    const [box, other] = previews;
    if (other.type !== 'extrusion') throw new Error('expected extrusion fixture');
    const before = sketch.serialize();
    const invalid: SolidEntity[][] = [
      [box, { ...other, depth: 0 }],
      [box, { ...other, depth: NaN }],
      [box, { ...other, id: 'missing' }],
      [box, box],
    ];
    const reasons: string[] = [];
    sketch.onChange((reason) => reasons.push(reason));
    for (const inputs of invalid) {
      expect(commands.extrudeMany(inputs).ok).toBe(false);
      expect(sketch.serialize()).toBe(before);
    }
    expect(reasons).toEqual([]);
    expect(commands.undo()).toBe('add rect');
  });

  it('keeps single-shape undo labels and does not record empty or unchanged batches', () => {
    const { sketch, commands, previews } = setup();
    expect(commands.extrudeMany([previews[0]]).ok).toBe(true);
    expect(commands.undo()).toBe('extrude 100 mm');
    commands.redo();
    const before = sketch.serialize();
    const reasons: string[] = [];
    sketch.onChange((reason) => reasons.push(reason));
    expect(commands.extrudeMany([])).toMatchObject({ ok: true, entities: [] });
    expect(commands.extrudeMany([previews[0]])).toMatchObject({ ok: true, entities: [] });
    expect(sketch.serialize()).toBe(before);
    expect(reasons).toEqual([]);
    expect(commands.undo()).toBe('extrude 100 mm');
  });
});
