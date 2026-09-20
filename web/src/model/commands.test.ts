import { describe, expect, it } from 'vitest';
import { Commands, parseDimensionSpec } from './commands';
import { makeRect, Sketch, type EntityInput, type LineEntity, type RectEntity, type SolidEntity } from './sketch';
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

describe('Commands.move', () => {
  const inputs: EntityInput[] = [
    { type: 'line', a: v3(10, 20, 30), b: v3(110, 20, 30) },
    { type: 'rect', corners: makeRect(v3(10, 20, 30), v3(1, 0, 0), v3(0, 1, 0), 100, 80) },
    { type: 'extrusion', corners: makeRect(v3(10, 20, 30), v3(1, 0, 0), v3(0, 1, 0), 100, 80), depth: -50 },
    { type: 'triangle', corners: [v3(10, 20, 30), v3(110, 20, 30), v3(10, 100, 30)] },
    { type: 'prism', corners: [v3(10, 20, 30), v3(110, 20, 30), v3(10, 100, 30)], depth: -50 },
  ];

  it.each(inputs.map((input) => [input.type, input] as const))('translates a %s as one undoable edit', (type, input) => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const entity = sketch.addEntity(input);
    const bystander = sketch.addEntity({ type: 'line', a: v3(0, 0, 0), b: v3(1, 0, 0) });
    const original = structuredClone(entity);
    const serialized = sketch.serialize();
    const reasons: string[] = [];
    sketch.onChange((reason) => reasons.push(reason));

    const result = commands.move(entity.id, v3(25, -15, 40));
    expect(result.ok).toBe(true);
    const moved = sketch.get(entity.id)!;
    expect(moved).not.toBe(entity);
    expect(moved.id).toBe(entity.id);
    expect(moved.type).toBe(type);
    if (moved.type === 'line') {
      expect(moved.a).toEqual(v3(35, 5, 70));
      expect(moved.b).toEqual(v3(135, 5, 70));
    } else if (moved.type === 'triangle' || moved.type === 'prism') {
      expect(moved.corners).toEqual([v3(35, 5, 70), v3(135, 5, 70), v3(35, 85, 70)]);
      if (moved.type === 'prism') expect(moved.depth).toBe(-50);
    } else {
      expect(moved.corners).toEqual([v3(35, 5, 70), v3(135, 5, 70), v3(135, 85, 70), v3(35, 85, 70)]);
      if (moved.type === 'extrusion') expect(moved.depth).toBe(-50);
    }
    expect(entity).toEqual(original);
    expect(sketch.get(bystander.id)).toBe(bystander);
    expect(reasons).toEqual([`move ${type}`]);

    const movedSerialized = sketch.serialize();
    expect(commands.undo()).toBe(`move ${type}`);
    expect(sketch.serialize()).toBe(serialized);
    expect(commands.redo()).toBe(`move ${type}`);
    expect(sketch.serialize()).toBe(movedSerialized);
  });

  it('rejects missing ids and non-finite offsets without touching history', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const entity = sketch.addEntity({ type: 'line', a: v3(0, 0, 0), b: v3(10, 0, 0) });
    const serialized = sketch.serialize();
    const reasons: string[] = [];
    sketch.onChange((reason) => reasons.push(reason));
    expect(commands.move('missing', v3(1, 0, 0)).ok).toBe(false);
    for (const bad of [v3(NaN, 0, 0), v3(0, Infinity, 0), v3(0, 0, -Infinity)]) {
      expect(commands.move(entity.id, bad).ok).toBe(false);
    }
    expect(sketch.serialize()).toBe(serialized);
    expect(reasons).toEqual([]);
    expect(commands.undo()).toBe('add line');
  });

  it('treats a zero offset as a no-op that keeps the redo stack', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const entity = sketch.addEntity({ type: 'rect', corners: makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 10, 10) });
    expect(commands.move(entity.id, v3(10, 0, 0)).ok).toBe(true);
    commands.undo();
    const before = sketch.get(entity.id);
    const reasons: string[] = [];
    sketch.onChange((reason) => reasons.push(reason));
    const result = commands.move(entity.id, v3(0, 0, 0));
    expect(result).toMatchObject({ ok: true, message: 'Position unchanged' });
    if (result.ok) expect(result.entity).toBe(before);
    expect(reasons).toEqual([]);
    expect(commands.redo()).toBe('move rect');
  });

  it('rejects a move that overflows coordinates without mutation or history', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const entity = sketch.addEntity({ type: 'line', a: v3(Number.MAX_VALUE, 0, 0), b: v3(0, 0, 0) });
    const serialized = sketch.serialize();
    const reasons: string[] = [];
    sketch.onChange((reason) => reasons.push(reason));
    expect(commands.move(entity.id, v3(Number.MAX_VALUE, 0, 0)).ok).toBe(false);
    expect(sketch.serialize()).toBe(serialized);
    expect(sketch.get(entity.id)).toBe(entity);
    expect(reasons).toEqual([]);
  });
});

describe('Commands.scale', () => {
  const inputs: EntityInput[] = [
    { type: 'line', a: v3(10, 20, 30), b: v3(110, 20, 30) },
    { type: 'rect', corners: makeRect(v3(10, 20, 30), v3(1, 0, 0), v3(0, 1, 0), 100, 80) },
    { type: 'extrusion', corners: makeRect(v3(10, 20, 30), v3(1, 0, 0), v3(0, 1, 0), 100, 80), depth: -50 },
    { type: 'triangle', corners: [v3(10, 20, 30), v3(110, 20, 30), v3(40, 100, 30)] },
    { type: 'prism', corners: [v3(10, 20, 30), v3(110, 20, 30), v3(40, 100, 30)], depth: -50 },
  ];
  const pivot = v3(10, 20, 30);

  it.each(inputs.flatMap((input) => [2, 0.5].map((factor) => [input.type, factor, input] as const)))(
    'scales a %s by a factor of %s about its origin as one undoable edit',
    (type, factor, input) => {
      const sketch = new Sketch();
      const commands = new Commands(sketch);
      const entity = sketch.addEntity(input);
      const bystander = sketch.addEntity({ type: 'line', a: v3(0, 0, 0), b: v3(1, 0, 0) });
      const original = structuredClone(entity);
      const serialized = sketch.serialize();
      const reasons: string[] = [];
      sketch.onChange((reason) => reasons.push(reason));

      const result = commands.scale(entity.id, pivot, factor);
      expect(result.ok).toBe(true);
      const scaled = sketch.get(entity.id)!;
      expect(scaled).not.toBe(entity);
      expect(scaled.id).toBe(entity.id);
      expect(scaled.type).toBe(type);
      if (scaled.type === 'line') {
        expect(scaled.a).toEqual(pivot);
        expect(scaled.b).toEqual(v3(10 + 100 * factor, 20, 30));
      } else if (scaled.type === 'triangle' || scaled.type === 'prism') {
        expect(scaled.corners).toEqual([v3(10, 20, 30), v3(10 + 100 * factor, 20, 30), v3(10 + 30 * factor, 20 + 80 * factor, 30)]);
        if (scaled.type === 'prism') expect(scaled.depth).toBe(-50 * factor);
      } else {
        expect(scaled.corners).toEqual([
          v3(10, 20, 30),
          v3(10 + 100 * factor, 20, 30),
          v3(10 + 100 * factor, 20 + 80 * factor, 30),
          v3(10, 20 + 80 * factor, 30),
        ]);
        if (scaled.type === 'extrusion') expect(scaled.depth).toBe(-50 * factor);
      }
      expect(entity).toEqual(original);
      expect(sketch.get(bystander.id)).toBe(bystander);
      expect(sketch.all.map((e) => e.id)).toEqual([entity.id, bystander.id]);
      expect(reasons).toEqual([`scale ${type}`]);

      const scaledSerialized = sketch.serialize();
      expect(commands.undo()).toBe(`scale ${type}`);
      expect(sketch.serialize()).toBe(serialized);
      expect(commands.redo()).toBe(`scale ${type}`);
      expect(sketch.serialize()).toBe(scaledSerialized);
    },
  );

  it('scales a rectangle about its true opposite corner, not the sketch origin', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const entity = sketch.addEntity({ type: 'rect', corners: makeRect(v3(10, 20, 30), v3(1, 0, 0), v3(0, 1, 0), 100, 80) });
    const result = commands.scale(entity.id, v3(110, 100, 30), 2);
    expect(result.ok).toBe(true);
    const rect = sketch.get(entity.id) as RectEntity;
    expect(rect.corners).toEqual([v3(-90, -60, 30), v3(110, -60, 30), v3(110, 100, 30), v3(-90, 100, 30)]);
  });

  it('rejects missing ids, bad anchors and bad factors without mutation or history', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const entity = sketch.addEntity({ type: 'line', a: v3(0, 0, 0), b: v3(10, 0, 0) });
    const serialized = sketch.serialize();
    const reasons: string[] = [];
    sketch.onChange((reason) => reasons.push(reason));
    expect(commands.scale('missing', v3(0, 0, 0), 2).ok).toBe(false);
    for (const factor of [Number.NaN, Infinity, -Infinity, 0, -1]) {
      expect(commands.scale(entity.id, v3(0, 0, 0), factor).ok).toBe(false);
    }
    for (const anchor of [v3(Number.NaN, 0, 0), v3(0, Infinity, 0), v3(0, 0, -Infinity)]) {
      expect(commands.scale(entity.id, anchor, 2).ok).toBe(false);
    }
    expect(sketch.serialize()).toBe(serialized);
    expect(sketch.get(entity.id)).toBe(entity);
    expect(reasons).toEqual([]);
    expect(commands.undo()).toBe('add line');
  });

  it.each(inputs.map((input) => [input.type, input] as const))(
    'rejects factors that collapse or overflow a %s without mutation or history',
    (_type, input) => {
      const sketch = new Sketch();
      const commands = new Commands(sketch);
      const entity = sketch.addEntity(input);
      const serialized = sketch.serialize();
      const reasons: string[] = [];
      sketch.onChange((reason) => reasons.push(reason));
      expect(commands.scale(entity.id, pivot, 1e-9).ok).toBe(false);
      expect(commands.scale(entity.id, pivot, Number.MAX_VALUE).ok).toBe(false);
      expect(sketch.serialize()).toBe(serialized);
      expect(sketch.get(entity.id)).toBe(entity);
      expect(reasons).toEqual([]);
    },
  );

  it('treats a factor of 1 as a no-op that keeps the redo stack', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const entity = sketch.addEntity({ type: 'rect', corners: makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 10, 10) });
    expect(commands.scale(entity.id, v3(0, 0, 0), 2).ok).toBe(true);
    commands.undo();
    const before = sketch.get(entity.id);
    const reasons: string[] = [];
    sketch.onChange((reason) => reasons.push(reason));
    const result = commands.scale(entity.id, v3(0, 0, 0), 1);
    expect(result).toMatchObject({ ok: true, message: 'Size unchanged' });
    if (result.ok) expect(result.entity).toBe(before);
    expect(reasons).toEqual([]);
    expect(commands.redo()).toBe('scale rect');
  });
});

describe('Commands: triangles and prisms', () => {
  const tri = (): [ReturnType<typeof v3>, ReturnType<typeof v3>, ReturnType<typeof v3>] =>
    [v3(10, 20, 30), v3(110, 20, 30), v3(10, 100, 30)];

  it('adds a valid triangle and rejects degenerate ones', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const added = commands.addTriangle(tri());
    expect(added.ok).toBe(true);
    expect(sketch.last).toMatchObject({ type: 'triangle' });
    expect(commands.addTriangle([v3(0, 0, 0), v3(100, 0, 0), v3(200, 0, 0)]).ok).toBe(false);
    expect(commands.addTriangle([v3(0, 0, 0), v3(NaN, 0, 0), v3(0, 100, 0)]).ok).toBe(false);
    expect(sketch.size).toBe(1);
  });

  it('extrudes a triangle into a prism as one undoable edit, then re-edits the signed depth', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const added = commands.addTriangle(tri());
    if (!added.ok) throw new Error(added.error);
    const id = added.entity.id;
    const before = sketch.serialize();
    const reasons: string[] = [];
    sketch.onChange((reason) => reasons.push(reason));

    const result = commands.extrude(id, -50);
    expect(result.ok).toBe(true);
    const prism = sketch.get(id);
    expect(prism).toMatchObject({ id, type: 'prism', corners: tri(), depth: -50 });
    expect(reasons).toEqual(['extrude prism -50 mm']);

    expect(commands.extrude(id, 75).ok).toBe(true);
    expect(sketch.get(id)).toMatchObject({ type: 'prism', depth: 75 });
    expect(commands.setDimension(id, '-25 cm').ok).toBe(true);
    expect(sketch.get(id)).toMatchObject({ type: 'prism', depth: -250 });

    expect(commands.undo()).toBe('extrude prism -250 mm');
    expect(commands.undo()).toBe('extrude prism 75 mm');
    expect(commands.undo()).toBe('extrude prism -50 mm');
    expect(sketch.serialize()).toBe(before);
    expect(sketch.get(id)).toMatchObject({ type: 'triangle', corners: tri() });
    expect(commands.redo()).toBe('extrude prism -50 mm');
    commands.redo();
    commands.redo();
    expect(sketch.get(id)).toMatchObject({ type: 'prism', depth: -250 });
  });

  it('rejects mismatched extrusion geometry and invalid depths without mutation', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const triangle = commands.addTriangle(tri());
    const rect = commands.addRect(makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 100, 80));
    if (!triangle.ok || !rect.ok) throw new Error('fixture');
    const before = sketch.serialize();
    const reasons: string[] = [];
    sketch.onChange((reason) => reasons.push(reason));

    const four = makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 100, 80);
    expect(commands.extrude(triangle.entity.id, 100, four).ok).toBe(false);
    expect(commands.extrude(rect.entity.id, 100, tri()).ok).toBe(false);
    for (const depth of [0, NaN, Infinity, -Infinity]) {
      expect(commands.extrude(triangle.entity.id, depth).ok).toBe(false);
    }
    expect(sketch.serialize()).toBe(before);
    expect(reasons).toEqual([]);
  });

  it('treats a same-depth extrusion as a no-op that keeps the redo stack', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const added = commands.addTriangle(tri());
    if (!added.ok) throw new Error(added.error);
    expect(commands.extrude(added.entity.id, 50).ok).toBe(true);
    expect(commands.extrude(added.entity.id, 75).ok).toBe(true);
    expect(commands.undo()).toBe('extrude prism 75 mm');
    expect(sketch.canRedo).toBe(true);
    const prism = sketch.get(added.entity.id);
    if (prism?.type !== 'prism') throw new Error('unreachable');
    const serialized = sketch.serialize();
    const reasons: string[] = [];
    sketch.onChange((reason) => reasons.push(reason));
    const noop = commands.extrude(added.entity.id, 50, prism.corners);
    expect(noop).toMatchObject({ ok: true, message: 'Prism depth unchanged' });
    if (noop.ok) expect(noop.entity).toBe(prism);
    expect(sketch.serialize()).toBe(serialized);
    expect(reasons).toEqual([]);
    expect(sketch.canRedo).toBe(true);
    expect(commands.redo()).toBe('extrude prism 75 mm');
    expect(sketch.get(added.entity.id)).toMatchObject({ type: 'prism', depth: 75 });
    expect(commands.undo()).toBe('extrude prism 75 mm');
    expect(commands.undo()).toBe('extrude prism 50 mm');
    expect(commands.undo()).toBe('add triangle');
  });

  it('applies a mixed prism + box batch atomically and rejects a bad triangle preview for all', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const triCorners = tri();
    const triangle = commands.addTriangle(triCorners);
    const rect = commands.addRect(makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 100, 80));
    if (!triangle.ok || !rect.ok) throw new Error('fixture');
    const previews: SolidEntity[] = [
      { id: triangle.entity.id, type: 'prism', corners: triCorners, depth: 60 },
      { id: rect.entity.id, type: 'extrusion', corners: makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 100, 80), depth: 40 },
    ];
    const result = commands.extrudeMany(previews);
    expect(result.ok).toBe(true);
    expect(sketch.all).toEqual(previews);
    expect(commands.undo()).toBe('extrude 2 shapes');
    commands.redo();

    const reasons: string[] = [];
    sketch.onChange((reason) => reasons.push(reason));
    const after = sketch.serialize();
    const bad: SolidEntity[] = [
      { id: triangle.entity.id, type: 'prism', corners: [v3(0, 0, 0), v3(100, 0, 0), v3(200, 0, 0)], depth: 60 },
      previews[1],
    ];
    expect(commands.extrudeMany(bad).ok).toBe(false);
    expect(sketch.serialize()).toBe(after);
    expect(reasons).toEqual([]);
  });

  it('exports triangles and signed prisms without dropping other entities', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    commands.addLine(v3(0, 0, 0), v3(0, 0, 10));
    const triangle = commands.addTriangle(tri());
    if (!triangle.ok) throw new Error(triangle.error);
    const first = commands.exportPayload();
    expect(first).toEqual({ units: 'mm', entities: [
      { type: 'line', points: [[0, 0, 0], [0, 0, 10]] },
      { type: 'triangle', points: [[10, 20, 30], [110, 20, 30], [10, 100, 30]] },
    ] });
    expect(commands.extrude(triangle.entity.id, -50).ok).toBe(true);
    expect(commands.exportPayload().entities[1]).toEqual({
      type: 'prism', points: [[10, 20, 30], [110, 20, 30], [10, 100, 30]], vector: [-0, -0, -50],
    });
    expect(first.entities[1].type).toBe('triangle');
  });

  it.each([-50, 50])('preserves a tilted prism with signed depth %s', (depth) => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    sketch.addEntity({ type: 'prism', corners: [v3(10, 20, 30), v3(110, 20, 30), v3(40, 100, 90)], depth });
    const entity = commands.exportPayload().entities[0];
    expect(entity.type).toBe('prism');
    if (entity.type !== 'prism') throw new Error('expected a prism');
    expect(entity.points).toEqual([[10, 20, 30], [110, 20, 30], [40, 100, 90]]);
    expect(entity.vector[0]).toBeCloseTo(0);
    expect(entity.vector[1]).toBeCloseTo(-0.6 * depth);
    expect(entity.vector[2]).toBeCloseTo(0.8 * depth);
  });

  it('exports an explicit preview without changing model or undo history', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const entity = sketch.addEntity({ type: 'prism', corners: tri(), depth: 50 });
    if (entity.type !== 'prism') throw new Error('expected a prism');
    const before = sketch.serialize();
    const payload = commands.exportPayload([{ ...entity, depth: 75 }]);
    expect(payload.entities[0]).toMatchObject({ type: 'prism', vector: [0, 0, 75] });
    expect(sketch.serialize()).toBe(before);
    expect(commands.undo()).toBe('add prism');
  });

  it('rejects triangle and prism moves that overflow or collapse coordinates without mutation or history', () => {
    for (const input of [
      { type: 'triangle', corners: tri() },
      { type: 'prism', corners: tri(), depth: -50 },
    ] as EntityInput[]) {
      const sketch = new Sketch();
      const commands = new Commands(sketch);
      const entity = sketch.addEntity(input);
      const serialized = sketch.serialize();
      const reasons: string[] = [];
      sketch.onChange((reason) => reasons.push(reason));
      expect(commands.move(entity.id, v3(Number.MAX_VALUE, 0, 0)).ok).toBe(false);
      expect(commands.move(entity.id, v3(1e20, 0, 0)).ok).toBe(false);
      expect(sketch.serialize()).toBe(serialized);
      expect(sketch.get(entity.id)).toBe(entity);
      expect(reasons).toEqual([]);
    }
  });
});
