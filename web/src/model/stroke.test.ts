import { describe, expect, it } from 'vitest';
import { WorkPlane, type PlaneKind } from './plane';
import { snapCursor, type SnapResult } from './snap';
import { makeRect, Sketch } from './sketch';
import { alignRectToStart, anchorAfterCommit, buildEntityFromStroke, pullRectCorners, StrokeSession } from './stroke';
import { circleStroke, rectStroke, rotatePoints, topViewProjector, triangleStroke } from './test-helpers';
import { v2, v3, type Vec2, type Vec3 } from './vec';

const projector = topViewProjector(0.1, 400, 300);
const plane = new WorkPlane('XY');

function floorSketch(): Sketch {
  const sketch = new Sketch();
  sketch.addEntity({ type: 'rect', corners: makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000) });
  return sketch;
}

function snapAt(world: Vec3, sketch: Sketch, strokeStart: Vec3 | null = null): SnapResult {
  return snapCursor({
    cursor: projector.project(world)!,
    projector,
    plane,
    targets: { vertices: sketch.vertices(), midpoints: sketch.midpoints(), segments: sketch.segments() },
    gridStep: 100,
    gridEnabled: true,
    strokeStart,
  });
}

describe('StrokeSession', () => {
  it('keeps raw points for the path and snapped points for the endpoints', () => {
    const sketch = floorSketch();
    const start = snapAt(v3(4030, 20, 0), sketch);
    expect(start.type).toBe('vertex');
    const session = new StrokeSession(plane, start);
    for (let i = 1; i <= 20; i++) {
      const raw = v3(4000 + i * 150 + 7, 0 + i * 3, 0);
      const snap = snapAt(raw, sketch, start.world);
      session.add(snap, snap.raw, projector.project(raw)!);
    }
    const points = session.planePoints();
    expect(points[0]).toEqual(v2(4000, 0));
    // Middle points are raw, not grid-rounded.
    expect(points[5].x % 100).not.toBe(0);
    const recognised = session.recognize();
    expect(recognised.shape?.kind).toBe('line');
    expect(session.screenExtent()).toBeGreaterThan(200);
  });

  it('drops samples that barely moved on screen', () => {
    const sketch = floorSketch();
    const start = snapAt(v3(500, 500, 0), sketch);
    const session = new StrokeSession(plane, start);
    const snap = snapAt(v3(505, 500, 0), sketch);
    expect(session.add(snap, snap.raw, projector.project(v3(505, 500, 0))!)).toBe(false);
    expect(session.pointCount).toBe(2);
  });
});

describe('buildEntityFromStroke', () => {
  it('uses exact snapped vertices for line endpoints, even off-plane ones', () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'line', a: v3(0, 0, 0), b: v3(0, 0, 2500) });
    sketch.addEntity({ type: 'line', a: v3(4000, 0, 0), b: v3(4000, 0, 2500) });
    const start = snapAt(v3(0, 0, 0), sketch);
    // Both wall tops project onto the same screen points as their bases in top view,
    // but the vertex list contains the tops too; pick them explicitly.
    const topA: SnapResult = { ...start, type: 'vertex', world: v3(0, 0, 2500), plane: v2(0, 0), onPlane: false, raw: v3(0, 0, 0) };
    const topB: SnapResult = { ...start, type: 'vertex', world: v3(4000, 0, 2500), plane: v2(4000, 0), onPlane: false, raw: v3(4000, 0, 0) };
    const session = new StrokeSession(plane, topA);
    session.add(topB, v3(4000, 0, 0), projector.project(v3(4000, 0, 0))!);
    const shape = session.recognize().shape!;
    const entity = buildEntityFromStroke(session, shape, { projector, vertices: sketch.vertices(), tolerancePx: 14 });
    expect(entity).toEqual({ type: 'line', a: v3(0, 0, 2500), b: v3(4000, 0, 2500) });
    expect(anchorAfterCommit(entity)).toEqual(v3(4000, 0, 2500));
  });

  it('pulls rectangle corners onto nearby on-plane vertices while staying rectangular', () => {
    const sketch = floorSketch();
    const corners = [v3(4030, -20, 0), v3(7000, -20, 0), v3(7000, 2960, 0), v3(4030, 2960, 0)];
    const pulled = pullRectCorners(corners, plane, { projector, vertices: sketch.vertices(), tolerancePx: 14 });
    expect(pulled[0]).toEqual(v3(4000, 0, 0));
    expect(pulled[1]).toEqual(v3(7000, 0, 0));
    expect(pulled[2]).toEqual(v3(7000, 3000, 0));
    expect(pulled[3]).toEqual(v3(4000, 3000, 0));
  });

  it('anchors an axis-aligned rectangle on the pen-down point and rounds the far corner to the grid', () => {
    const corners = [v2(1003, 496), v2(3960, 496), v2(3960, 2531), v2(1003, 2531)];
    const aligned = alignRectToStart(corners, v2(1000, 500), 100);
    expect(aligned).toEqual([v2(1000, 500), v2(4000, 500), v2(4000, 2500), v2(1000, 2500)]);
    // Drawn from the top-right corner going the other way round: order is preserved.
    const reversed = [v2(3960, 2531), v2(1003, 2531), v2(1003, 496), v2(3960, 496)];
    expect(alignRectToStart(reversed, v2(4000, 2500), 100)).toEqual([v2(4000, 2500), v2(1000, 2500), v2(1000, 500), v2(4000, 500)]);
    // Without a grid only the start corner moves.
    expect(alignRectToStart(corners, v2(1000, 500), 0)[2]).toEqual(v2(3960, 2531));
  });

  it('does not pull corners onto off-plane vertices', () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'line', a: v3(0, 0, 500), b: v3(1000, 0, 500) });
    const corners = [v3(5, 5, 0), v3(1000, 5, 0), v3(1000, 800, 0), v3(5, 800, 0)];
    const pulled = pullRectCorners(corners, plane, { projector, vertices: sketch.vertices(), tolerancePx: 14 });
    expect(pulled).toEqual(corners);
  });

  it('builds a wall rectangle from a stroke that starts on a floor corner', () => {
    const sketch = floorSketch();
    const start = snapAt(v3(4010, 10, 0), sketch);
    expect(start.type).toBe('vertex');
    const wallPlane = new WorkPlane('XZ', start.world);
    const session = new StrokeSession(wallPlane, { ...start, plane: wallPlane.toPlane(start.world) }, true);
    const front = topViewProjector(0.1, 400, 300);
    for (const p of rectStroke(4000, 0, 3000, 2500, { jitter: 20, pointsPerSide: 25 }).slice(1)) {
      const world = wallPlane.toWorld(p);
      const snap: SnapResult = { type: 'free', world, plane: p, screen: v2(p.x * 0.1, -p.y * 0.1), onPlane: true, raw: world };
      session.add(snap, world, snap.screen);
    }
    const result = session.recognize();
    expect(result.shape?.kind).toBe('rect');
    const entity = buildEntityFromStroke(session, result.shape!, { projector: front, vertices: sketch.vertices(), tolerancePx: 14 });
    expect(entity.type).toBe('rect');
    if (entity.type !== 'rect') return;
    for (const corner of entity.corners) expect(corner.y).toBeCloseTo(0);
    const zs = entity.corners.map((c) => c.z);
    expect(Math.max(...zs)).toBeCloseTo(2500, -2);
    expect(Math.min(...zs)).toBeCloseTo(0, -2);
  });
});

describe('StrokeSession: circles', () => {
  it.each([
    ['XY', 81], ['XZ', 81], ['YZ', 81],
    ['XY', 61], ['XZ', 61], ['YZ', 61],
  ] as [PlaneKind, number][])('recognises a raw circle on %s from %s samples despite grid-snapped endpoints', (kind, count) => {
    const circlePlane = new WorkPlane(kind, v3(100, 200, 300));
    const raw = circleStroke(700, 800, 250).slice(0, count);
    const snapFor = (p: Vec2): SnapResult => ({
      type: 'grid',
      world: circlePlane.toWorld(v2(p.x + 100, p.y + 100)),
      plane: v2(p.x + 100, p.y + 100),
      screen: v2(p.x / 2, p.y / 2),
      onPlane: true,
      raw: circlePlane.toWorld(p),
    });
    const session = new StrokeSession(circlePlane, snapFor(raw[0]));
    for (const p of raw.slice(1)) {
      session.add(snapFor(p), circlePlane.toWorld(p), v2(p.x / 2, p.y / 2), 0);
    }
    const result = session.recognize();
    expect(result.shape?.kind).toBe('circle');
    if (result.shape?.kind !== 'circle') return;
    expect(Math.abs(result.shape.center.x - 700)).toBeLessThan(1e-6);
    expect(Math.abs(result.shape.center.y - 800)).toBeLessThan(1e-6);
    expect(Math.abs(result.shape.radius - 250)).toBeLessThan(1e-6);
    const entity = buildEntityFromStroke(session, result.shape, { projector, vertices: [], tolerancePx: 14, gridStep: 1000 });
    expect(entity.type).toBe('circle');
    if (entity.type !== 'circle') return;
    const expectedCenter = circlePlane.toWorld(v2(700, 800));
    expect(entity.center.x).toBeCloseTo(expectedCenter.x, 6);
    expect(entity.center.y).toBeCloseTo(expectedCenter.y, 6);
    expect(entity.center.z).toBeCloseTo(expectedCenter.z, 6);
    expect(entity.normal).toEqual(circlePlane.normal);
    expect(entity.radius).toBeCloseTo(250, 6);
    expect(anchorAfterCommit(entity)).toEqual(entity.center);
  });

  it('does not turn a short arc into a circle just because the endpoints snap together', () => {
    const points = circleStroke(700, 800, 250).slice(0, 41);
    const workPlane = new WorkPlane('XY');
    const snapFor = (raw: Vec2, snapped: Vec2): SnapResult => ({
      type: 'grid', world: workPlane.toWorld(snapped), plane: snapped,
      screen: v2(raw.x / 2, raw.y / 2), onPlane: true, raw: workPlane.toWorld(raw),
    });
    const session = new StrokeSession(workPlane, snapFor(points[0], points[0]));
    points.slice(1).forEach((point, index) => {
      const snapped = index === points.length - 2 ? points[0] : point;
      const snap = snapFor(point, snapped);
      session.add(snap, snap.raw, snap.screen, 0);
    });
    expect(session.recognize().shape?.kind).not.toBe('circle');
  });
});

function sessionForSnappedStroke(points: readonly Vec2[]): StrokeSession {
  const snapFor = (raw: Vec2, strokeStart: Vec3 | null = null): SnapResult => snapCursor({
    cursor: projector.project(v3(raw.x, raw.y, 0))!,
    projector,
    plane,
    targets: { vertices: [], midpoints: [], segments: [] },
    gridStep: 100,
    gridEnabled: true,
    strokeStart,
  });
  const session = new StrokeSession(plane, snapFor(points[0]));
  for (const point of points.slice(1)) {
    const rawWorld = v3(point.x, point.y, 0);
    session.add(snapFor(point, session.start.world), rawWorld, projector.project(rawWorld)!, 0);
  }
  return session;
}

function bowedSquareStroke(bow: number): Vec2[] {
  const corners = [v2(1000, 500), v2(2000, 500), v2(2000, 1500), v2(1000, 1500)];
  const points: Vec2[] = [];
  for (let side = 0; side < corners.length; side++) {
    const a = corners[side];
    const b = corners[(side + 1) % corners.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    for (let i = 0; i < 16; i++) {
      const t = i / 16;
      const offset = Math.sin(Math.PI * t) * bow;
      points.push(v2(a.x + dx * t - dy / length * offset, a.y + dy * t + dx / length * offset));
    }
  }
  points.push(points[0]);
  return points;
}

describe('StrokeSession: rough rectangles versus circle correction', () => {
  it('recognises snapped rough squares, a small closing gap, rotation, and a bowed side as rectangles', () => {
    const strokes = [
      rectStroke(1000, 500, 1000, 1000, { pointsPerSide: 12, jitter: 80 }),
      rectStroke(1000, 500, 1000, 1000, { pointsPerSide: 8, jitter: 120, overshoot: 0.04 }),
      rectStroke(1000, 500, 1000, 1000, { pointsPerSide: 10, jitter: 80, gapFraction: 0.02 }),
      rotatePoints(rectStroke(1000, 500, 1000, 1000, { pointsPerSide: 12, jitter: 80 }), 0.35, v2(1500, 1000)),
      bowedSquareStroke(50),
    ];
    for (const points of strokes) {
      const session = sessionForSnappedStroke(points);
      const result = session.recognize();
      expect(result.shape?.kind).toBe('rect');
      if (!result.shape) continue;
      const entity = buildEntityFromStroke(session, result.shape, { projector, vertices: [], tolerancePx: 14, gridStep: 100 });
      expect(entity.type).toBe('rect');
    }
  });
});

describe('StrokeSession: triangles', () => {
  it.each(['XY', 'XZ', 'YZ'] as PlaneKind[])('recognises a raw triangle on %s despite grid-snapped endpoints', (kind) => {
    const triPlane = new WorkPlane(kind, v3(100, 200, 300));
    const corners: [Vec2, Vec2, Vec2] = [v2(700, 500), v2(1300, 500), v2(900, 1100)];
    const raw = triangleStroke(corners);
    const snapFor = (p: Vec2): SnapResult => ({
      type: 'grid',
      world: triPlane.toWorld(v2(p.x + 100, p.y + 100)),
      plane: v2(p.x + 100, p.y + 100),
      screen: v2(p.x / 2, p.y / 2),
      onPlane: true,
      raw: triPlane.toWorld(p),
    });
    const session = new StrokeSession(triPlane, snapFor(raw[0]));
    for (const p of raw.slice(1)) {
      session.add(snapFor(p), triPlane.toWorld(p), v2(p.x / 2, p.y / 2), 0);
    }
    const result = session.recognize();
    expect(result.shape?.kind).toBe('triangle');
    const entity = buildEntityFromStroke(session, result.shape!, { projector, vertices: [], tolerancePx: 14 });
    expect(entity.type).toBe('triangle');
    if (entity.type !== 'triangle') return;
    expect(entity.corners).toHaveLength(3);
    for (const corner of entity.corners) expect(triPlane.contains(corner, 1e-6)).toBe(true);
    for (const [index, corner] of entity.corners.entries()) {
      const expected = triPlane.toWorld(corners[index]);
      expect(corner.x).toBeCloseTo(expected.x, 6);
      expect(corner.y).toBeCloseTo(expected.y, 6);
      expect(corner.z).toBeCloseTo(expected.z, 6);
    }
    expect(anchorAfterCommit(entity)).toEqual(entity.corners[0]);
  });

  const triangleShape = (corners: [Vec2, Vec2, Vec2]) => ({ kind: 'triangle' as const, corners });
  const freeStart = (at: Vec2, type: SnapResult['type'] = 'free', world?: Vec3): SnapResult => ({
    type,
    world: world ?? plane.toWorld(at),
    plane: at,
    screen: projector.project(plane.toWorld(at))!,
    onPlane: true,
    raw: world ?? plane.toWorld(at),
  });

  it('rounds triangle corners to the grid and keeps raw corners when the grid is off', () => {
    const shape = triangleShape([v2(13, 17), v2(293, 17), v2(113, 217)]);
    const session = new StrokeSession(plane, freeStart(shape.corners[0]));
    const snapped = buildEntityFromStroke(session, shape, { projector, vertices: [], tolerancePx: 14, gridStep: 100 });
    expect(snapped).toEqual({ type: 'triangle', corners: [v3(0, 0, 0), v3(300, 0, 0), v3(100, 200, 0)] });
    const raw = buildEntityFromStroke(session, shape, { projector, vertices: [], tolerancePx: 14, gridStep: 0 });
    if (raw.type !== 'triangle') throw new Error('unreachable');
    expect(raw.corners).toEqual([v3(13, 17, 0), v3(293, 17, 0), v3(113, 217, 0)]);
    expect(anchorAfterCommit(raw)).toEqual(v3(13, 17, 0));
  });

  it('snaps triangle corners onto nearby on-plane vertices but not off-plane ones', () => {
    const unit = topViewProjector(1, 0, 0);
    const sketch = new Sketch();
    sketch.addEntity({ type: 'line', a: v3(1000, 1000, 0), b: v3(1000, 1000, 900) });
    const shape = triangleShape([v2(1008, 996), v2(1300, 1000), v2(1100, 1400)]);
    const session = new StrokeSession(plane, freeStart(shape.corners[0]));
    const entity = buildEntityFromStroke(session, shape, { projector: unit, vertices: sketch.vertices(), tolerancePx: 14, gridStep: 0 });
    if (entity.type !== 'triangle') throw new Error('unreachable');
    expect(entity.corners[0]).toEqual(v3(1000, 1000, 0));
    expect(entity.corners[1]).toEqual(v3(1300, 1000, 0));
    expect(entity.corners[2]).toEqual(v3(1100, 1400, 0));
  });

  it('honours an explicit object-snap start near a true corner', () => {
    const unit = topViewProjector(1, 0, 0);
    const start = freeStart(v2(0, 0), 'midpoint', v3(1002, 1000, 0));
    const session = new StrokeSession(plane, start);
    const shape = triangleShape([v2(1008, 996), v2(1300, 1000), v2(1100, 1400)]);
    const entity = buildEntityFromStroke(session, shape, { projector: unit, vertices: [], tolerancePx: 14, gridStep: 0 });
    if (entity.type !== 'triangle') throw new Error('unreachable');
    expect(entity.corners[0]).toEqual(v3(1002, 1000, 0));
  });

  it('falls back to raw corners when a coarse grid collapses the triangle', () => {
    const shape = triangleShape([v2(13, 17), v2(293, 17), v2(113, 217)]);
    const session = new StrokeSession(plane, freeStart(shape.corners[0]));
    const entity = buildEntityFromStroke(session, shape, { projector, vertices: [], tolerancePx: 14, gridStep: 1000 });
    if (entity.type !== 'triangle') throw new Error('unreachable');
    expect(entity.corners).toEqual([v3(13, 17, 0), v3(293, 17, 0), v3(113, 217, 0)]);
  });

  it('does not replace a real corner with a mid-edge stroke start', () => {
    const session = new StrokeSession(plane, { ...freeStart(v2(500, 0), 'grid'), world: v3(500, 0, 0), raw: v3(500, 0, 0) });
    const shape = triangleShape([v2(0, 0), v2(1000, 0), v2(350, 800)]);
    const entity = buildEntityFromStroke(session, shape, { projector, vertices: [], tolerancePx: 14, gridStep: 0 });
    if (entity.type !== 'triangle') throw new Error('unreachable');
    expect(entity.corners).toEqual([v3(0, 0, 0), v3(1000, 0, 0), v3(350, 800, 0)]);
  });

  it('does not invent a triangle just because the endpoints snap together', () => {
    const points = triangleStroke([v2(0, 0), v2(1000, 0), v2(350, 800)], { gapFraction: 0.3 });
    const workPlane = new WorkPlane('XY');
    const snapFor = (raw: Vec2, snapped: Vec2): SnapResult => ({
      type: 'grid', world: workPlane.toWorld(snapped), plane: snapped,
      screen: v2(raw.x / 2, raw.y / 2), onPlane: true, raw: workPlane.toWorld(raw),
    });
    const session = new StrokeSession(workPlane, snapFor(points[0], points[0]));
    points.slice(1).forEach((point, index) => {
      const snapped = index === points.length - 2 ? points[0] : point;
      const snap = snapFor(point, snapped);
      session.add(snap, snap.raw, snap.screen, 0);
    });
    expect(session.recognize().shape?.kind).not.toBe('triangle');
  });
});
