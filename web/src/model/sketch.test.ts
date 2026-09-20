import { describe, expect, it } from 'vitest';
import { circlePoints, entitySegments, entityTriangles, entityVertices, makeRect, rectFrame, Sketch, type EntityInput } from './sketch';
import { distance, dot, normalize, sub, v3 } from './vec';

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

describe('Sketch: polygon profiles', () => {
  const triangle = [v3(0, 0, 0), v3(400, 0, 0), v3(100, 300, 0)];
  const concave = [v3(0, 0, 0), v3(400, 0, 0), v3(400, 100, 0), v3(100, 100, 0), v3(100, 300, 0), v3(0, 300, 0)];

  it('stores a polygon on any work-plane offset, in either winding', () => {
    const sketch = new Sketch();
    const lifted = triangle.map((p) => v3(p.x, p.y, 500));
    const flipped = [...concave].reverse();
    const a = sketch.addEntity({ type: 'polygon', corners: lifted });
    const b = sketch.addEntity({ type: 'polygon', corners: flipped });
    expect(a.type).toBe('polygon');
    expect(b.type).toBe('polygon');
    expect(sketch.vertices()).toHaveLength(9);
    expect(sketch.segments()).toHaveLength(9);
    const solid = sketch.addEntity({ type: 'extrusion', corners: triangle, depth: -120 });
    expect(entityVertices(solid)).toHaveLength(6);
    expect(entitySegments(solid)).toHaveLength(9);
    const capArea = entityTriangles(solid)
      .filter((t) => t[0].z === t[1].z && t[1].z === t[2].z)
      .reduce((sum, [a2, b2, c2]) => sum + Math.abs((b2.x - a2.x) * (c2.y - a2.y) - (c2.x - a2.x) * (b2.y - a2.y)) / 2, 0);
    expect(capArea).toBeCloseTo(120000);
  });

  it('triangulates a concave cap without filling the notch', () => {
    const sketch = new Sketch();
    const solid = sketch.addEntity({ type: 'extrusion', corners: concave, depth: 100 });
    const cap = entityTriangles(solid).filter((t) => t.every((p) => p.z === 0));
    expect(cap).toHaveLength(4);
    const area = cap.reduce((sum, [a, b, c]) => sum + Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2, 0);
    expect(area).toBeCloseTo(60000);
  });

  it('round-trips polygon and generic extrusion entities through serialization', () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'polygon', corners: triangle });
    sketch.addEntity({ type: 'extrusion', corners: concave, depth: -250 });
    const restored = Sketch.fromJSON(JSON.parse(sketch.serialize()));
    expect(restored.toJSON()).toEqual(sketch.toJSON());
  });

  it('rejects open, warped, self-crossing and degenerate outlines', () => {
    const sketch = new Sketch();
    const bowtie = [v3(0, 0, 0), v3(400, 300, 0), v3(0, 300, 0), v3(400, 0, 0)];
    const asymmetricCrossing = [v3(0, 0, 0), v3(400, 300, 0), v3(0, 300, 0), v3(300, 0, 0)];
    const touching = [v3(0, 0, 0), v3(400, 0, 0), v3(200, 100, 0), v3(400, 300, 0), v3(0, 300, 0), v3(200, 100, 0)];
    const backtracking = [v3(0, 0, 0), v3(400, 0, 0), v3(200, 0, 0), v3(100, 300, 0)];
    const warped = [v3(0, 0, 0), v3(400, 0, 0), v3(400, 300, 0), v3(0, 300, 50)];
    const collapsed = [v3(0, 0, 0), v3(100, 0, 0), v3(50, 0, 0)];
    for (const corners of [bowtie, asymmetricCrossing, touching, backtracking, warped, collapsed]) {
      expect(() => sketch.addEntity({ type: 'polygon', corners })).toThrow();
      expect(() => sketch.addEntity({ type: 'extrusion', corners, depth: 100 })).toThrow();
    }
    expect(() => sketch.addEntity({ type: 'extrusion', corners: triangle, depth: 0 })).toThrow();
    expect(() => sketch.addEntity({ type: 'extrusion', corners: triangle, depth: Number.NaN })).toThrow();
    expect(sketch.size).toBe(0);
    expect(sketch.canUndo).toBe(false);
  });

  it('accepts leading collinear vertices and huge coordinates', () => {
    const sketch = new Sketch();
    const collinear = [v3(0, 0, 0), v3(200, 0, 0), v3(400, 0, 0), v3(100, 300, 0)];
    expect(sketch.addEntity({ type: 'polygon', corners: collinear }).type).toBe('polygon');
    const big = triangle.map((p) => v3(p.x + 1e9, p.y + 1e9, p.z));
    expect(sketch.addEntity({ type: 'polygon', corners: big }).type).toBe('polygon');
  });
});

describe('Sketch: line loops', () => {
  const addLine = (sketch: Sketch, a: ReturnType<typeof v3>, b: ReturnType<typeof v3>) =>
    sketch.addEntity({ type: 'line', a, b });

  it('detects a triangle loop regardless of line order or winding', () => {
    const sketch = new Sketch();
    const e1 = addLine(sketch, v3(400, 0, 0), v3(0, 0, 0));
    const e2 = addLine(sketch, v3(100, 300, 0), v3(400, 0, 0));
    const e3 = addLine(sketch, v3(0, 0, 0), v3(100, 300, 0));
    const loops = sketch.closedLineProfiles;
    expect(loops).toHaveLength(1);
    expect(loops[0].corners).toHaveLength(3);
    expect([...loops[0].sourceIds].sort()).toEqual([e1.id, e2.id, e3.id]);
    expect(loops[0].id).toBe(`loop:${JSON.stringify([e1.id, e2.id, e3.id].sort())}`);
    expect(sketch.getProfile(loops[0].id)).toBe(loops[0]);
    expect(sketch.getProfile(e1.id)).toBe(loops[0]);
    expect(sketch.drawable.map((entity) => entity.id)).toEqual([loops[0].id]);
    expect(sketch.serialize()).not.toContain('loop:');
    expect(sketch.size).toBe(3);
  });

  it('detects loops on non-zero plane offsets and ignores dangling branches', () => {
    const sketch = new Sketch();
    addLine(sketch, v3(0, 0, 700), v3(400, 0, 700));
    addLine(sketch, v3(400, 0, 700), v3(400, 300, 700));
    addLine(sketch, v3(400, 300, 700), v3(0, 300, 700));
    addLine(sketch, v3(0, 300, 700), v3(0, 0, 700));
    addLine(sketch, v3(0, 0, 700), v3(-900, -900, 700));
    expect(sketch.closedLineProfiles).toHaveLength(1);
    expect(sketch.closedLineProfiles[0].corners.every((p) => p.z === 700)).toBe(true);
  });

  it('detects two loops sharing one endpoint and two loops sharing an edge', () => {
    const bowtie = new Sketch();
    addLine(bowtie, v3(0, 0, 0), v3(300, 0, 0));
    addLine(bowtie, v3(300, 0, 0), v3(150, 200, 0));
    addLine(bowtie, v3(150, 200, 0), v3(0, 0, 0));
    addLine(bowtie, v3(0, 0, 0), v3(-300, 0, 0));
    addLine(bowtie, v3(-300, 0, 0), v3(-150, 200, 0));
    addLine(bowtie, v3(-150, 200, 0), v3(0, 0, 0));
    expect(bowtie.closedLineProfiles).toHaveLength(2);

    const adjacent = new Sketch();
    addLine(adjacent, v3(0, 0, 0), v3(400, 0, 0));
    addLine(adjacent, v3(400, 0, 0), v3(400, 300, 0));
    addLine(adjacent, v3(400, 300, 0), v3(0, 300, 0));
    const shared = addLine(adjacent, v3(0, 300, 0), v3(0, 0, 0));
    addLine(adjacent, v3(0, 300, 0), v3(-400, 300, 0));
    addLine(adjacent, v3(-400, 300, 0), v3(-400, 0, 0));
    addLine(adjacent, v3(-400, 0, 0), v3(0, 0, 0));
    const loops = adjacent.closedLineProfiles;
    expect(loops).toHaveLength(2);
    expect(adjacent.getProfile(shared.id)).toBeNull();
    expect(adjacent.getProfile(loops[0].id)).not.toBeNull();
  });

  it('rejects open, missing-edge, warped, crossing and duplicated boundaries', () => {
    const open = new Sketch();
    addLine(open, v3(0, 0, 0), v3(400, 0, 0));
    addLine(open, v3(400, 0, 0), v3(100, 300, 0));
    expect(open.closedLineProfiles).toHaveLength(0);

    const warped = new Sketch();
    addLine(warped, v3(0, 0, 0), v3(400, 0, 0));
    addLine(warped, v3(400, 0, 0), v3(400, 300, 50));
    addLine(warped, v3(400, 300, 50), v3(0, 300, 25));
    addLine(warped, v3(0, 300, 25), v3(0, 0, 0));
    expect(warped.closedLineProfiles).toHaveLength(0);

    const crossing = new Sketch();
    addLine(crossing, v3(0, 0, 0), v3(400, 300, 0));
    addLine(crossing, v3(400, 300, 0), v3(0, 300, 0));
    addLine(crossing, v3(0, 300, 0), v3(400, 0, 0));
    addLine(crossing, v3(400, 0, 0), v3(0, 0, 0));
    expect(crossing.closedLineProfiles).toHaveLength(0);

    const duplicated = new Sketch();
    addLine(duplicated, v3(0, 0, 0), v3(400, 0, 0));
    addLine(duplicated, v3(0, 0, 0), v3(400, 0, 0));
    addLine(duplicated, v3(400, 0, 0), v3(100, 300, 0));
    addLine(duplicated, v3(100, 300, 0), v3(0, 0, 0));
    expect(duplicated.closedLineProfiles).toHaveLength(0);
  });

  it('keeps loop-cache identity stable and invalidates it on every mutation', () => {
    const sketch = new Sketch();
    const e1 = addLine(sketch, v3(0, 0, 0), v3(400, 0, 0));
    addLine(sketch, v3(400, 0, 0), v3(100, 300, 0));
    addLine(sketch, v3(100, 300, 0), v3(0, 0, 0));
    const first = sketch.closedLineProfiles;
    const firstDrawable = sketch.drawable;
    expect(sketch.closedLineProfiles).toBe(first);
    expect(sketch.drawable).toBe(firstDrawable);
    const added = addLine(sketch, v3(0, 0, 500), v3(100, 0, 500));
    expect(sketch.closedLineProfiles).not.toBe(first);
    expect(sketch.closedLineProfiles).toHaveLength(1);
    sketch.removeEntity(added.id);
    expect(sketch.closedLineProfiles).toHaveLength(1);
    sketch.removeEntity(e1.id);
    expect(sketch.closedLineProfiles).toHaveLength(0);
    sketch.undo();
    expect(sketch.closedLineProfiles).toHaveLength(1);
    sketch.undo();
    expect(sketch.closedLineProfiles).toHaveLength(1);
    sketch.load(JSON.parse(sketch.serialize()));
    expect(sketch.closedLineProfiles).toHaveLength(1);
    sketch.load({ version: 1, units: 'mm', entities: [] });
    expect(sketch.closedLineProfiles).toHaveLength(0);
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

describe('Sketch: circles', () => {
  it('stores a unit normal and isolates the input vectors', () => {
    const sketch = new Sketch();
    const center = v3(100, 200, 300);
    const normal = v3(0, 0, 2);
    const circle = sketch.addEntity({ type: 'circle', center, normal, radius: 50 });
    expect(circle.type).toBe('circle');
    if (circle.type !== 'circle') return;
    expect(circle.normal).toEqual(v3(0, 0, 1));
    center.x = 999;
    normal.z = -5;
    expect(circle.center).toEqual(v3(100, 200, 300));
    expect(circle.normal).toEqual(v3(0, 0, 1));
  });

  it('serialises and survives add/delete undo and redo', () => {
    const sketch = new Sketch();
    const circle = sketch.addEntity({ type: 'circle', center: v3(100, 200, 300), normal: v3(0, 0, 1), radius: 50 });
    const restored = Sketch.fromJSON(JSON.parse(sketch.serialize()));
    expect(restored.toJSON()).toEqual(sketch.toJSON());
    sketch.undo();
    expect(sketch.size).toBe(0);
    sketch.redo();
    expect(sketch.size).toBe(1);
    sketch.removeEntity(circle.id);
    expect(sketch.size).toBe(0);
    sketch.undo();
    expect(sketch.get(circle.id)?.type).toBe('circle');
  });

  it('exposes centre + quadrant vertices, a 96-segment outline and 96 disk triangles', () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'circle', center: v3(100, 200, 300), normal: v3(0, 0, 1), radius: 50 });
    expect(sketch.vertices()).toHaveLength(5);
    expect(sketch.midpoints()).toHaveLength(0);
    expect(sketch.segments()).toHaveLength(96);
    expect(entityTriangles(sketch.all[0])).toHaveLength(96);
  });

  it('computes exact world-axis extrema and planar points for a tilted circle', () => {
    const sketch = new Sketch();
    const circle = sketch.addEntity({ type: 'circle', center: v3(100, 200, 300), normal: v3(1, 1, 1), radius: 30 });
    if (circle.type !== 'circle') throw new Error('unreachable');
    const box = sketch.boundingBox();
    expect(box).not.toBeNull();
    const extent = 30 * Math.sqrt(2 / 3);
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(Math.abs(box!.min[axis] - (circle.center[axis] - extent))).toBeLessThan(1e-6);
      expect(Math.abs(box!.max[axis] - (circle.center[axis] + extent))).toBeLessThan(1e-6);
    }
    const normal = normalize(circle.normal);
    for (const point of circlePoints(circle)) {
      expect(Math.abs(dot(sub(point, circle.center), normal))).toBeLessThan(1e-9);
      expect(distance(point, circle.center)).toBeCloseTo(30, 9);
    }
  });

  it('rejects invalid circles without touching the model or history', () => {
    const sketch = new Sketch();
    const base = { type: 'circle' as const, center: v3(100, 200, 300), normal: v3(0, 0, 1), radius: 50 };
    const invalid = [
      { ...base, radius: 0 },
      { ...base, radius: -1 },
      { ...base, radius: Number.NaN },
      { ...base, radius: Infinity },
      { ...base, normal: v3(0, 0, 0) },
      { ...base, normal: v3(0, 0, Number.NaN) },
      { ...base, center: v3(Infinity, 200, 300) },
      { type: 'circle' as const, center: v3(0, 0, 0), radius: 5 },
    ];
    for (const input of invalid) {
      expect(() => sketch.addEntity(input as Parameters<Sketch['addEntity']>[0])).toThrow();
    }
    expect(sketch.size).toBe(0);
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
