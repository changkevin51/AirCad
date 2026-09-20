import { describe, expect, it } from 'vitest';
import { Commands } from './commands';
import { ExtrusionSession } from './extrusion';
import { pickProfileFace, profileFaces, pushPull } from './faces';
import { pickFace } from './pick';
import { WorkPlane } from './plane';
import { snapCursor } from './snap';
import { entityCenter, entityFaces, entityPoints, entitySegments, entityTriangles, Sketch, type CircleEntity, type CylinderEntity } from './sketch';
import { frontViewProjector, topViewProjector } from './test-helpers';
import { add, cross, dot, normalize, sub, v2, v3 } from './vec';

const circle = (): CircleEntity => ({
  id: 'circle',
  type: 'circle',
  center: v3(100, 200, 300),
  normal: v3(0, 0, 1),
  radius: 50,
});

describe('native cylinders', () => {
  it('extrudes a circle into a native cylinder and replaces it in one undo step', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const added = commands.addCircle(circle().center, circle().normal, circle().radius);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const result = commands.extrude(added.entity.id, -120);
    expect(result.ok).toBe(true);
    expect(sketch.all).toHaveLength(1);
    expect(sketch.last).toMatchObject({ type: 'cylinder', center: v3(100, 200, 300), normal: v3(0, 0, 1), radius: 50, depth: -120 });
    expect(sketch.undo()).toMatch(/extrude/);
    expect(sketch.last?.type).toBe('circle');
    expect(sketch.redo()).toMatch(/extrude/);
    expect(sketch.last?.type).toBe('cylinder');
  });

  it('keeps invalid depths out of model history and edits cylinder depth by measurement', () => {
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const added = commands.addCircle(v3(0, 0, 0), v3(1, 2, 3), 20);
    if (!added.ok) throw new Error('circle was rejected');
    expect(commands.extrude(added.entity.id, 0).ok).toBe(false);
    expect(commands.extrude(added.entity.id, Number.NaN).ok).toBe(false);
    expect(sketch.canUndo).toBe(true); // only the circle add is in history
    expect(commands.extrude(added.entity.id, 100).ok).toBe(true);
    const id = added.entity.id;
    expect(commands.setDimension(id, '-25 cm').ok).toBe(true);
    expect((sketch.get(id) as CylinderEntity).depth).toBe(-250);
    expect(commands.setDimension(id, '10x20').ok).toBe(false);
    expect((sketch.get(id) as CylinderEntity).depth).toBe(-250);
  });

  it('serializes, bounds, centres, and triangulates a closed tilted cylinder', () => {
    const sketch = new Sketch();
    const entity = sketch.addEntity({ type: 'cylinder', center: v3(10, 20, 30), normal: v3(1, 2, 3), radius: 40, depth: -120 }) as CylinderEntity;
    const restored = Sketch.fromJSON(JSON.parse(sketch.serialize()));
    expect(restored.toJSON()).toEqual(sketch.toJSON());
    const centre = entityCenter(entity);
    const unitNormal = normalize(entity.normal);
    const topCenter = add(entity.center, { x: unitNormal.x * entity.depth, y: unitNormal.y * entity.depth, z: unitNormal.z * entity.depth });
    expect(centre.x).toBeCloseTo((entity.center.x + topCenter.x) / 2, 9);
    expect(centre.y).toBeCloseTo((entity.center.y + topCenter.y) / 2, 9);
    expect(centre.z).toBeCloseTo((entity.center.z + topCenter.z) / 2, 9);
    expect(entityPoints(entity)).toHaveLength(12);
    expect(entityFaces(entity)).toHaveLength(98);
    expect(entityTriangles(entity)).toHaveLength(384);
    expect(entityTriangles(entity).every((triangle) => triangle.every((point) => Number.isFinite(point.x + point.y + point.z)))).toBe(true);
    const box = sketch.boundingBox();
    expect(box).not.toBeNull();
    for (const axis of ['x', 'y', 'z'] as const) {
      const extent = entity.radius * Math.sqrt(1 - unitNormal[axis] * unitNormal[axis]);
      const expectedMin = Math.min(entity.center[axis], topCenter[axis]) - extent;
      const expectedMax = Math.max(entity.center[axis], topCenter[axis]) + extent;
      expect(box!.min[axis]).toBeCloseTo(expectedMin, 8);
      expect(box!.max[axis]).toBeCloseTo(expectedMax, 8);
    }
    const triangles = entityTriangles(entity);
    for (const [a, b, c] of triangles) {
      const faceNormal = cross(sub(b, a), sub(c, a));
      const centroid = v3((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3);
      expect(dot(faceNormal, sub(centroid, centre))).toBeGreaterThan(0);
    }
    const edgeCounts = new Map<string, number>();
    const pointKey = (point: { x: number; y: number; z: number }) => `${point.x.toFixed(8)},${point.y.toFixed(8)},${point.z.toFixed(8)}`;
    for (const triangle of triangles) {
      for (const [a, b] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]] as const) {
        const key = [pointKey(a), pointKey(b)].sort().join('|');
        edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
      }
    }
    expect([...edgeCounts.values()].every((count) => count === 2)).toBe(true);
  });

  it('selects analytic caps and curved sides, and snaps both rings', () => {
    const entity: CylinderEntity = { ...circle(), id: 'cylinder', type: 'cylinder', depth: 200 };
    expect(pickFace([entity], v2(100, -200), topViewProjector(1, 0, 0))?.id).toBe(entity.id);
    expect(pickFace([entity], v2(100, -300), frontViewProjector(1, 0, 0))?.id).toBe(entity.id);
    expect(pickFace([entity], v2(151, -200), topViewProjector(1, 0, 0))).toBeNull();
    const sketch = new Sketch();
    sketch.addEntity(entity);
    expect(entitySegments(sketch.all[0])).toHaveLength(196);
    expect(sketch.vertices()).toHaveLength(10);

    const ringSketch = new Sketch();
    ringSketch.addEntity({ type: 'cylinder', center: v3(0, 0, 0), normal: v3(0, 0, 1), radius: 100, depth: 200 });
    const projector = topViewProjector(1, 0, 0);
    const angle = Math.PI / 96;
    const truePoint = v3(100 * Math.cos(angle), 100 * Math.sin(angle), 0);
    const cursorPoint = v3(100.5 * Math.cos(angle), 100.5 * Math.sin(angle), 0);
    const snap = snapCursor({
      cursor: projector.project(cursorPoint)!,
      projector,
      plane: new WorkPlane('XY'),
      targets: { vertices: ringSketch.vertices(), midpoints: ringSketch.midpoints(), segments: ringSketch.segments() },
      gridStep: 0,
      gridEnabled: false,
      tolerancePx: 2,
    });
    expect(snap.type).toBe('edge');
    expect(Math.hypot(snap.world.x, snap.world.y)).toBeCloseTo(100, 7);
    expect(snap.world.x).toBeCloseTo(truePoint.x, 6);
    expect(snap.world.y).toBeCloseTo(truePoint.y, 6);
  });

  it('moves the base when pulling the near cap and keeps face signs stable through both depth signs', () => {
    const entity: CylinderEntity = { ...circle(), id: 'cylinder', type: 'cylinder', depth: 100 };
    const faces = profileFaces(entity);
    expect(faces.map((face) => face.sign)).toEqual([1, -1]);
    const near = faces[1];
    const moved = pushPull(entity, near, 25, 1);
    expect(moved.depth).toBe(125);
    expect(moved.center).toEqual(v3(100, 200, 275));
    const negative = { ...entity, depth: -100 };
    const negativeFaces = profileFaces(negative);
    expect(negativeFaces.map((face) => face.sign)).toEqual([1, -1]);
    const negativeNear = negativeFaces[0];
    const movedNegative = pushPull(negative, negativeNear, 25, 1);
    expect(movedNegative.depth).toBe(-125);
    expect(movedNegative.center).toEqual(v3(100, 200, 325));
    const session = new ExtrusionSession(entity, 1, 1, 1);
    session.setPull(25);
    expect(session.preview).toMatchObject({ type: 'cylinder', depth: 125, center: v3(100, 200, 275) });
  });

  it('keeps profile face picking exact at the circular rim and chooses the camera-facing flat cap', () => {
    const profile: CircleEntity = circle();
    const faces = profileFaces(profile);
    expect(pickProfileFace(faces, v2(150, -200), topViewProjector(1, 0, 0))).toBe(0);
    expect(pickProfileFace(faces, v2(150.01, -200), topViewProjector(1, 0, 0))).toBeNull();
    const fromBelow = { ...topViewProjector(1, 0, 0), ray: () => ({ origin: v3(100, 200, -100), dir: v3(0, 0, 1) }) };
    expect(pickProfileFace(faces, v2(100, 200), fromBelow)).toBe(1);
  });
});
