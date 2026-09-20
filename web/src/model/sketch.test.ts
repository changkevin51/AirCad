import { describe, expect, it } from 'vitest';
import { describeEntity, entityCenter, entityFaces, entityMidpoints, entityScaleHandles, entitySegments, entityTriangles, entityVertices, extrusionNormal, extrusionOffset, isTriangleProfile, makeRect, rectFrame, scaleEntity, Sketch, translateEntity, type Entity, type EntityInput, type PrismEntity, type TriangleEntity } from './sketch';
import { entityLabel } from '../render/sketch-renderer';
import { add, cross, distance, dot, lerp, nearlyEqual, sub, v3, type Vec3 } from './vec';

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

describe('corner scale handles', () => {
  const rectCorners = () => makeRect(v3(10, 20, 30), v3(1, 0, 0), v3(0, 1, 0), 100, 80);
  const fixtures: Entity[] = [
    { id: 'l', type: 'line', a: v3(10, 20, 30), b: v3(110, 20, 30) },
    { id: 'r', type: 'rect', corners: rectCorners() },
    { id: 'e', type: 'extrusion', corners: rectCorners(), depth: 50 },
  ];

  it.each([
    ['line', 2],
    ['rect', 4],
    ['extrusion', 8],
  ] as const)('a %s offers %i corner handles', (type, count) => {
    const entity = fixtures.find((candidate) => candidate.type === type)!;
    expect(entityScaleHandles(entity)).toHaveLength(count);
  });


  it.each(fixtures.map((entity) => [entity.type, entity] as const))(
    'anchors every %s handle on another offered point, symmetric about the centre',
    (_type, entity) => {
      const handles = entityScaleHandles(entity);
      for (const handle of handles) {
        expect(handles.some((other) => nearlyEqual(other.point, handle.anchor, 1e-9))).toBe(true);
        expect(nearlyEqual(lerp(handle.point, handle.anchor, 0.5), entityCenter(entity), 1e-9)).toBe(true);
      }
    },
  );

  it('anchors each rectangle corner at the diagonally opposite corner', () => {
    const rect = fixtures[1];
    if (rect.type !== 'rect') throw new Error('unreachable');
    const handles = entityScaleHandles(rect);
    expect(handles.map((handle) => handle.point)).toEqual(rect.corners);
    handles.forEach((handle, index) => {
      expect(handle.anchor).toEqual(rect.corners[(index + 2) % 4]);
    });
  });

  it.each([50, -50])('anchors box base corners on the far cap and top corners on the base (depth %i)', (depth) => {
    const extrusion: Entity = { id: 'x', type: 'extrusion', corners: rectCorners(), depth };
    if (extrusion.type !== 'extrusion') throw new Error('unreachable');
    const offset = extrusionOffset(extrusion);
    const handles = entityScaleHandles(extrusion);
    handles.slice(0, 4).forEach((handle, index) => {
      expect(handle.point).toEqual(extrusion.corners[index]);
      expect(handle.anchor).toEqual(add(extrusion.corners[(index + 2) % 4], offset));
    });
    handles.slice(4).forEach((handle, index) => {
      expect(handle.point).toEqual(add(extrusion.corners[index], offset));
      expect(handle.anchor).toEqual(extrusion.corners[(index + 2) % 4]);
    });
  });

  it('keeps the opposite-corner pairing for rotated and tilted shapes', () => {
    const rotated: Entity = {
      id: 'rot',
      type: 'rect',
      corners: makeRect(v3(10, 20, 30), v3(0.6, 0.8, 0), v3(-0.8, 0.6, 0), 100, 80),
    };
    const tilted: Entity = {
      id: 'tilt',
      type: 'extrusion',
      corners: makeRect(v3(10, 20, 30), v3(1, 0, 0), v3(0, 0, 1), 100, 80),
      depth: -50,
    };
    for (const entity of [rotated, tilted]) {
      const handles = entityScaleHandles(entity);
      for (const handle of handles) {
        expect(handles.some((other) => nearlyEqual(other.point, handle.anchor, 1e-9))).toBe(true);
        expect(nearlyEqual(lerp(handle.point, handle.anchor, 0.5), entityCenter(entity), 1e-9)).toBe(true);
      }
    }
    if (rotated.type !== 'rect') throw new Error('unreachable');
    entityScaleHandles(rotated).forEach((handle, index) => {
      expect(handle.anchor).toEqual(rotated.corners[(index + 2) % 4]);
    });
  });

  it('leaves a handle on the anchor after scaling by 2', () => {
    const rect = fixtures[1];
    const anchor = entityScaleHandles(rect)[2].anchor;
    const scaled = scaleEntity(rect, anchor, 2);
    if (!scaled) throw new Error('scale rejected');
    expect(entityScaleHandles(scaled).some((handle) => nearlyEqual(handle.point, anchor, 1e-9))).toBe(true);
  });

  it.each([['triangle', 0], ['prism', 50], ['prism', -50]] as const)('pairs %s corners with the farthest actual corner at depth %i', (type, depth) => {
    const corners: [ReturnType<typeof v3>, ReturnType<typeof v3>, ReturnType<typeof v3>] = [v3(100, 100, 0), v3(500, 100, 0), v3(200, 400, 0)];
    const entity: Entity = type === 'triangle' ? { id: 't', type, corners } : { id: 'p', type, corners, depth };
    const handles = entityScaleHandles(entity);
    expect(handles).toHaveLength(type === 'triangle' ? 3 : 6);
    for (const handle of handles) {
      expect(handles.some((other) => nearlyEqual(other.point, handle.anchor, 1e-9))).toBe(true);
      expect(distance(handle.point, handle.anchor)).toBeCloseTo(Math.max(...handles.map((other) => distance(handle.point, other.point))), 9);
      const scaled = scaleEntity(entity, handle.anchor, 2);
      if (!scaled) throw new Error('scale rejected');
      expect(entityScaleHandles(scaled).some((other) => nearlyEqual(other.point, handle.anchor, 1e-9))).toBe(true);
    }
    expect(nearlyEqual(handles[2].anchor, v3(500, 100, depth), 1e-9)).toBe(true);
  });
});

describe('Sketch: triangles and prisms', () => {
  const tri = (): TriangleEntity['corners'] => [v3(0, 0, 0), v3(300, 0, 0), v3(0, 300, 0)];

  it('clones input corners and round-trips both shapes through JSON', () => {
    const sketch = new Sketch();
    const corners = tri();
    const triangle = sketch.addEntity({ type: 'triangle', corners });
    const prism = sketch.addEntity({ type: 'prism', corners: tri(), depth: -200 });
    if (triangle.type !== 'triangle' || prism.type !== 'prism') throw new Error('unreachable');
    corners[0].x = 999;
    expect(triangle.corners[0]).toEqual(v3(0, 0, 0));
    const restored = Sketch.fromJSON(JSON.parse(sketch.serialize()));
    expect(restored.toJSON()).toEqual(sketch.toJSON());
    expect(restored.get(prism.id)).toMatchObject({ type: 'prism', depth: -200 });
  });

  it('exposes 3 vertices, 3 segments and one triangular face for a flat triangle', () => {
    const sketch = new Sketch();
    const entity = sketch.addEntity({ type: 'triangle', corners: tri() });
    expect(entityVertices(entity)).toHaveLength(3);
    expect(entitySegments(entity)).toHaveLength(3);
    expect(entityMidpoints(entity)).toHaveLength(3);
    expect(entityFaces(entity)).toHaveLength(1);
    expect(entityFaces(entity)[0]).toHaveLength(3);
    expect(entityTriangles(entity)).toHaveLength(1);
  });

  it('exposes 6 vertices, 9 segments and five faces for a prism', () => {
    const sketch = new Sketch();
    const entity = sketch.addEntity({ type: 'prism', corners: tri(), depth: -200 });
    expect(entityVertices(entity)).toHaveLength(6);
    expect(entitySegments(entity)).toHaveLength(9);
    expect(entityMidpoints(entity)).toHaveLength(9);
    expect(entityFaces(entity)).toHaveLength(5);
    expect(entityTriangles(entity)).toHaveLength(8);
  });

  it('computes bounds and centres for flat and extruded triangles', () => {
    const flat = new Sketch();
    flat.addEntity({ type: 'triangle', corners: tri() });
    expect(flat.boundingBox()).toEqual({ min: v3(0, 0, 0), max: v3(300, 300, 0) });
    expect(entityCenter(flat.all[0])).toEqual(v3(100, 100, 0));

    const solid = new Sketch();
    const prism = solid.addEntity({ type: 'prism', corners: tri(), depth: -200 });
    expect(solid.boundingBox()).toEqual({ min: v3(0, 0, -200), max: v3(300, 300, 0) });
    expect(entityCenter(prism)).toEqual(v3(100, 100, -100));
  });

  it('survives add, delete, undo and redo with stable ids', () => {
    const sketch = new Sketch();
    const triangle = sketch.addEntity({ type: 'triangle', corners: tri() });
    const prism = sketch.addEntity({ type: 'prism', corners: tri(), depth: 150 });
    expect(sketch.all.map((e) => e.id)).toEqual([triangle.id, prism.id]);
    sketch.removeEntity(triangle.id);
    expect(sketch.all.map((e) => e.id)).toEqual([prism.id]);
    sketch.undo();
    expect(sketch.get(triangle.id)).toMatchObject({ type: 'triangle' });
    sketch.redo();
    expect(sketch.get(triangle.id)).toBeUndefined();
    expect(sketch.get(prism.id)).toMatchObject({ type: 'prism', depth: 150 });
  });

  it('rejects degenerate triangles and invalid prisms without touching the model or history', () => {
    const sketch = new Sketch();
    const invalid: EntityInput[] = [
      { type: 'triangle', corners: [v3(0, 0, 0), v3(100, 0, 0)] as unknown as TriangleEntity['corners'] },
      { type: 'triangle', corners: [v3(0, 0, 0), v3(100, 0, 0), v3(0, 100, 0), v3(0, 0, 0)] as unknown as TriangleEntity['corners'] },
      { type: 'triangle', corners: [v3(0, 0, 0), v3(100, 0, 0), v3(100, 0, 0)] },
      { type: 'triangle', corners: [v3(0, 0, 0), v3(100, 0, 0), v3(200, 0, 0)] },
      { type: 'triangle', corners: [v3(0, 0, 0), v3(Number.NaN, 0, 0), v3(0, 100, 0)] },
      { type: 'triangle', corners: [v3(0, 0, 0), v3(Infinity, 0, 0), v3(0, 100, 0)] },
      { type: 'prism', corners: tri(), depth: 0 },
      { type: 'prism', corners: tri(), depth: Number.NaN },
      { type: 'prism', corners: tri(), depth: Infinity },
      { type: 'prism', corners: [v3(0, 0, 0), v3(100, 0, 0), v3(200, 0, 0)], depth: 100 },
    ];
    for (const input of invalid) {
      expect(() => sketch.addEntity(input)).toThrow();
    }
    expect(sketch.size).toBe(0);
    expect(sketch.canUndo).toBe(false);
  });

  it.each([
    [v3(0, 0, 0), v3(300, 0, 0), v3(0, 300, 0)],
    [v3(0, 0, 0), v3(0, 300, 0), v3(300, 0, 0)],
  ])('gives a +Z extrusion normal independent of winding', (...corners) => {
    const triangle: TriangleEntity = { id: 't', type: 'triangle', corners };
    const prism: PrismEntity = { id: 'p', type: 'prism', corners, depth: 100 };
    for (const entity of [triangle, prism]) {
      const normal = extrusionNormal(entity);
      expect(normal.x).toBeCloseTo(0);
      expect(normal.y).toBeCloseTo(0);
      expect(normal.z).toBe(1);
    }
  });

  it('produces an outward-facing closed mesh for prisms on every plane, winding and depth sign', () => {
    const profiles: [Vec3, Vec3, Vec3][] = [
      [v3(0, 0, 0), v3(300, 0, 0), v3(0, 300, 0)],
      [v3(0, 0, 0), v3(0, 0, 300), v3(300, 0, 0)],
      [v3(0, 0, 0), v3(0, 300, 0), v3(0, 0, 300)],
    ];
    for (const corners of profiles) {
      for (const reversed of [false, true]) {
        for (const depth of [200, -200]) {
          const entity: PrismEntity = { id: 'p', type: 'prism', corners: reversed ? [...corners].reverse() as typeof corners : corners, depth };
          const centre = entityCenter(entity);
          const triangles = entityTriangles(entity);
          expect(triangles).toHaveLength(8);
          for (const [a, b, c] of triangles) {
            const faceNormal = cross(sub(b, a), sub(c, a));
            const centroid = v3((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3);
            expect(dot(faceNormal, sub(centroid, centre))).toBeGreaterThan(0);
          }
          const edgeCounts = new Map<string, number>();
          const pointKey = (point: Vec3) => `${point.x.toFixed(8)},${point.y.toFixed(8)},${point.z.toFixed(8)}`;
          for (const triangle of triangles) {
            for (const [a, b] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]] as const) {
              const key = [pointKey(a), pointKey(b)].sort().join('|');
              edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
            }
          }
          expect([...edgeCounts.values()].every((count) => count === 2)).toBe(true);
        }
      }
    }
  });

  it('translates triangles and prisms without changing their shape', () => {
    const triangle: TriangleEntity = { id: 't', type: 'triangle', corners: tri() };
    const moved = translateEntity(triangle, v3(10, 20, 30));
    if (moved.type !== 'triangle') throw new Error('unreachable');
    expect(moved.corners).toEqual([v3(10, 20, 30), v3(310, 20, 30), v3(10, 320, 30)]);
    const prism: PrismEntity = { id: 'p', type: 'prism', corners: tri(), depth: -50 };
    const movedPrism = translateEntity(prism, v3(10, 20, 30));
    if (movedPrism.type !== 'prism') throw new Error('unreachable');
    expect(movedPrism.corners).toEqual([v3(10, 20, 30), v3(310, 20, 30), v3(10, 320, 30)]);
    expect(movedPrism.depth).toBe(-50);
    expect(isTriangleProfile(movedPrism.corners)).toBe(true);
  });

  it('labels a triangle and a prism without falling into the rectangle path', () => {
    const triangle: Entity = { id: 't', type: 'triangle', corners: tri() };
    const prism: Entity = { id: 'p', type: 'prism', corners: tri(), depth: -200 };
    expect(entityLabel(triangle)).toBe('Triangle');
    expect(entityLabel(prism)).toBe('Depth -200 mm');
    expect(describeEntity(triangle)).toBe('triangle');
    expect(describeEntity(prism)).toBe('triangular prism depth -200 mm');
  });
});
