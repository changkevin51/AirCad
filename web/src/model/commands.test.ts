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

describe('Commands: polygons and line loops', () => {
  const triangle = [v3(0, 0, 0), v3(400, 0, 0), v3(100, 300, 0)];

  it('adds and extrudes a polygon profile with a signed depth', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const added = commands.addPolygon(triangle);
    if (!added.ok) throw new Error(added.error);
    const pulled = commands.extrude(added.entity.id, -250);
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) throw new Error(pulled.error);
    const solid = sketch.get(pulled.entity.id);
    expect(solid).toMatchObject({ type: 'extrusion', depth: -250 });
  });

  it('rejects invalid outlines and non-profiles with closed-outline guidance', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    expect(commands.addPolygon([v3(0, 0, 0), v3(100, 0, 0)]).ok).toBe(false);
    const bowtie = [v3(0, 0, 0), v3(400, 300, 0), v3(0, 300, 0), v3(400, 0, 0)];
    expect(commands.addPolygon(bowtie).ok).toBe(false);
    const open = sketch.addEntity({ type: 'line', a: v3(0, 0, 0), b: v3(400, 0, 0) });
    const snapshot = sketch.serialize();
    const result = commands.extrude(open.id, 100);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.error).toContain('closed');
    expect(sketch.size).toBe(1);
    expect(sketch.serialize()).toBe(snapshot);
    expect(sketch.undo()).toBe('add line');
    expect(sketch.canUndo).toBe(false);
  });

  it('extrudes a virtual loop and restores the exact source lines on undo', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const lines = [
      sketch.addEntity({ type: 'line', a: v3(0, 0, 0), b: v3(400, 0, 0) }),
      sketch.addEntity({ type: 'line', a: v3(400, 0, 0), b: v3(100, 300, 0) }),
      sketch.addEntity({ type: 'line', a: v3(100, 300, 0), b: v3(0, 0, 0) }),
    ];
    const keep = sketch.addEntity({ type: 'line', a: v3(0, 0, 500), b: v3(10, 10, 500) });
    const before = sketch.serialize();
    const loop = sketch.closedLineProfiles[0];
    const pulled = commands.extrude(loop.id, 250);
    expect(pulled.ok).toBe(true);
    for (const line of lines) expect(sketch.get(line.id)).toBeUndefined();
    expect(sketch.get(keep.id)).not.toBeUndefined();
    expect(sketch.size).toBe(2);
    expect(sketch.closedLineProfiles).toHaveLength(0);
    expect(sketch.undo()).toBeTruthy();
    expect(sketch.serialize()).toBe(before);
    for (const line of lines) expect(sketch.get(line.id)?.id).toBe(line.id);
    expect(sketch.redo()).toBeTruthy();
    const solidId = pulled.ok ? pulled.entity.id : '';
    expect(sketch.get(solidId)).toMatchObject({ type: 'extrusion', depth: 250 });
  });

  it('consumes only unshared source lines so a shared-edge neighbor loop survives', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const lines = [
      sketch.addEntity({ type: 'line', a: v3(0, 0, 0), b: v3(400, 0, 0) }),
      sketch.addEntity({ type: 'line', a: v3(400, 0, 0), b: v3(400, 300, 0) }),
      sketch.addEntity({ type: 'line', a: v3(400, 300, 0), b: v3(0, 300, 0) }),
      sketch.addEntity({ type: 'line', a: v3(0, 300, 0), b: v3(0, 0, 0) }),
      sketch.addEntity({ type: 'line', a: v3(0, 300, 0), b: v3(-400, 300, 0) }),
      sketch.addEntity({ type: 'line', a: v3(-400, 300, 0), b: v3(-400, 0, 0) }),
      sketch.addEntity({ type: 'line', a: v3(-400, 0, 0), b: v3(0, 0, 0) }),
    ];
    const sharedEdge = lines[3];
    const loops = sketch.closedLineProfiles;
    expect(loops).toHaveLength(2);
    const right = loops.find((loop) => loop.sourceIds.includes(lines[1].id))!;
    expect(commands.extrude(right.id, 100).ok).toBe(true);
    expect(sketch.get(sharedEdge.id)).not.toBeUndefined();
    expect(sketch.closedLineProfiles).toHaveLength(1);
    expect(sketch.get(lines[0].id)).toBeUndefined();
    expect(sketch.undo()).toBeTruthy();
    expect(sketch.get(lines[0].id)).not.toBeUndefined();
    expect(sketch.closedLineProfiles).toHaveLength(2);
  });

  it('refuses to delete a loop whose edges are all shared, without touching history', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    for (let j = 0; j <= 3; j++) {
      for (let i = 0; i < 3; i++) {
        sketch.addEntity({ type: 'line', a: v3(i * 100, j * 100, 0), b: v3((i + 1) * 100, j * 100, 0) });
      }
    }
    for (let i = 0; i <= 3; i++) {
      for (let j = 0; j < 3; j++) {
        sketch.addEntity({ type: 'line', a: v3(i * 100, j * 100, 0), b: v3(i * 100, (j + 1) * 100, 0) });
      }
    }
    const loops = sketch.closedLineProfiles;
    expect(loops).toHaveLength(9);
    const center = loops.find((loop) =>
      loop.sourceIds.every((id) => loops.filter((other) => other.sourceIds.includes(id)).length > 1),
    )!;
    expect(center).toBeDefined();
    const history = sketch.serialize();
    const result = commands.deleteEntity(center.id);
    expect(result.ok).toBe(false);
    expect(sketch.serialize()).toBe(history);
    const extruded = commands.extrude(center.id, 50);
    expect(extruded.ok).toBe(true);
    expect(sketch.size).toBe(25);
    expect(sketch.closedLineProfiles).toHaveLength(9);
    expect(sketch.undo()).toBe('extrude 50 mm');
    expect(sketch.undo()).toBe('add line');
  });

  it('edits generic solid depth but refuses W x H sizing on a polygon outline', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const solid = sketch.addEntity({ type: 'extrusion', corners: triangle, depth: 100 });
    expect(commands.setDimension(solid.id, '-450').ok).toBe(true);
    expect(sketch.get(solid.id)).toMatchObject({ type: 'extrusion', depth: -450 });
    expect(commands.setDimension(solid.id, '10x20').ok).toBe(false);
    const polygon = sketch.addEntity({ type: 'polygon', corners: triangle });
    expect(commands.setDimension(polygon.id, '75').ok).toBe(true);
    expect(sketch.get(polygon.id)).toMatchObject({ type: 'extrusion', depth: 75 });
    expect(commands.setDimension(polygon.id, '10x20').ok).toBe(false);
  });
});

describe('Commands: circles', () => {
  it('keeps a saved circle loadable and read-only for size edits and extrusion', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const circle = sketch.addEntity({ type: 'circle', center: v3(100, 200, 300), normal: v3(0, 1, 0), radius: 50 }) as CircleEntity;
    const before = sketch.serialize();
    const undoable = sketch.canUndo;
    expect(commands.setDimension(circle.id, '5 cm').ok).toBe(false);
    expect(commands.setDimension(circle.id, '10x20').ok).toBe(false);
    expect(commands.extrude(circle.id, 100).ok).toBe(false);
    expect(sketch.serialize()).toBe(before);
    expect(sketch.canUndo).toBe(undoable);
    expect((sketch.get(circle.id) as CircleEntity).radius).toBe(50);
    expect(commands.deleteEntity(circle.id).ok).toBe(true);
    expect(sketch.size).toBe(0);
    commands.undo();
    expect((sketch.get(circle.id) as CircleEntity).radius).toBe(50);
  });

  it('serializes circles alongside lines and rectangles', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    commands.addLine(v3(0, 0, 0), v3(0, 0, 10));
    commands.addRect(makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 10, 20));
    sketch.addEntity({ type: 'circle', center: v3(100, 200, 300), normal: v3(0, 1, 0), radius: 50 });
    const restored = Sketch.fromJSON(JSON.parse(sketch.serialize()));
    expect(restored.toJSON()).toEqual(sketch.toJSON());
    expect(restored.all.map((entity) => entity.type)).toEqual(['line', 'rect', 'circle']);
    expect(restored.last).toEqual({ id: 'e3', type: 'circle', center: v3(100, 200, 300), normal: v3(0, 1, 0), radius: 50 });
  });

  it('rejects invalid circle inputs at the model layer', () => {
    const sketch = new Sketch();
    expect(() => sketch.addEntity({ type: 'circle', center: v3(0, 0, 0), normal: v3(0, 0, 0), radius: 10 })).toThrow();
    expect(() => sketch.addEntity({ type: 'circle', center: v3(0, 0, 0), normal: v3(0, 0, 1), radius: -5 })).toThrow();
    expect(sketch.size).toBe(0);
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
