import { describe, expect, it } from 'vitest';
import { Commands, parseDimensionSpec } from './commands';
import { makeRect, Sketch, type CircleEntity, type LineEntity, type RectEntity, type SolidEntity } from './sketch';
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
});

describe('Commands: circles', () => {
  it('adds a circle and sets its diameter with units, undoable', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const added = commands.addCircle(v3(100, 200, 300), v3(0, 1, 0), 50);
    expect(added.ok).toBe(true);
    const id = added.ok ? added.entity.id : '';
    expect(commands.setDimension(id, '5 cm').ok).toBe(true);
    let circle = sketch.get(id) as CircleEntity;
    expect(circle.radius).toBe(25);
    expect(circle.center).toEqual(v3(100, 200, 300));
    expect(circle.normal).toEqual(v3(0, 1, 0));
    expect(commands.undo()).toMatch(/set diameter/);
    expect((sketch.get(id) as CircleEntity).radius).toBe(50);
    expect(commands.redo()).toMatch(/set diameter/);
    expect((sketch.get(id) as CircleEntity).radius).toBe(25);
    expect(commands.setDimension(id, '2 m').ok).toBe(true);
    circle = sketch.get(id) as CircleEntity;
    expect(circle.radius).toBe(1000);
  });

  it('rejects bad diameters without changing geometry or history', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const added = commands.addCircle(v3(100, 200, 300), v3(0, 1, 0), 50);
    const id = added.ok ? added.entity.id : '';
    const before = sketch.get(id);
    const undoable = sketch.canUndo;
    for (const spec of ['10x20', '0', 'NaN', '-5', '0.000001', { length: NaN }, { length: -5 }]) {
      expect(commands.setDimension(id, spec).ok).toBe(false);
    }
    expect(sketch.get(id)).toBe(before);
    expect(sketch.canUndo).toBe(undoable);
    expect(commands.undo()).toBe('add circle');
    expect(sketch.size).toBe(0);
  });

  it('serializes circles alongside lines and rectangles', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    commands.addLine(v3(0, 0, 0), v3(0, 0, 10));
    commands.addRect(makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 10, 20));
    commands.addCircle(v3(100, 200, 300), v3(0, 1, 0), 50);
    const restored = Sketch.fromJSON(JSON.parse(sketch.serialize()));
    expect(restored.toJSON()).toEqual(sketch.toJSON());
    expect(restored.all.map((entity) => entity.type)).toEqual(['line', 'rect', 'circle']);
    expect(restored.last).toEqual({ id: 'e3', type: 'circle', center: v3(100, 200, 300), normal: v3(0, 1, 0), radius: 50 });
  });

  it('extrudes a circle and validates circle inputs', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const added = commands.addCircle(v3(100, 200, 300), v3(0, 1, 0), 50);
    const id = added.ok ? added.entity.id : '';
    expect(commands.extrude(id, 100).ok).toBe(true);
    expect(sketch.get(id)?.type).toBe('cylinder');
    expect((sketch.get(id) as { radius: number }).radius).toBe(50);
    expect(commands.undo()).toMatch(/extrude/);
    expect((sketch.get(id) as CircleEntity).radius).toBe(50);
    expect(commands.redo()).toMatch(/extrude/);
    expect(sketch.get(id)?.type).toBe('cylinder');
    expect(commands.deleteEntity(id).ok).toBe(true);
    expect(sketch.size).toBe(0);
    commands.undo();
    expect(sketch.size).toBe(1);
    expect(commands.addCircle(v3(0, 0, 0), v3(0, 0, 0), 10).ok).toBe(false);
    expect(commands.addCircle(v3(0, 0, 0), v3(0, 0, 1), -5).ok).toBe(false);
  });
});

describe('Commands.extrudeMany', () => {
  function setup() {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const corners = makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 400, 300);
    const a = sketch.addEntity({ type: 'rect', corners });
    const b = sketch.addEntity({ type: 'circle', center: v3(700, 200, 0), normal: v3(0, 0, 1), radius: 50 });
    const previews: SolidEntity[] = [
      { id: a.id, type: 'extrusion', corners, depth: 100 },
      { id: b.id, type: 'cylinder', center: v3(700, 200, 0), normal: v3(0, 0, 1), radius: 50, depth: -200 },
    ];
    return { sketch, commands, previews };
  }

  it('applies mixed box and cylinder previews atomically and undoes both together', () => {
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
    const [box, cylinder] = previews;
    if (cylinder.type !== 'cylinder') throw new Error('expected cylinder fixture');
    const before = sketch.serialize();
    const invalid: SolidEntity[][] = [
      [box, { ...cylinder, depth: 0 }],
      [box, { ...cylinder, depth: NaN }],
      [box, { ...cylinder, radius: 0 }],
      [box, { ...cylinder, normal: v3(0, 0, 0) }],
      [box, { ...cylinder, id: 'missing' }],
      [box, box],
      [{ ...cylinder, id: box.id }],
      [{ ...box, id: cylinder.id }],
    ];
    const reasons: string[] = [];
    sketch.onChange((reason) => reasons.push(reason));
    for (const inputs of invalid) {
      expect(commands.extrudeMany(inputs).ok).toBe(false);
      expect(sketch.serialize()).toBe(before);
    }
    expect(reasons).toEqual([]);
    expect(commands.undo()).toBe('add circle');
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
