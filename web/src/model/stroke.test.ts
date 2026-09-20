import { describe, expect, it } from 'vitest';
import { WorkPlane, type PlaneKind } from './plane';
import { snapCursor, type SnapResult } from './snap';
import { sameRectangle } from './rect-completion';
import { makeRect, Sketch } from './sketch';
import {
  alignRectToStart,
  anchorAfterCommit,
  buildEntityFromStroke,
  pullRectCorners,
  resolveStroke,
  StrokeSession,
} from './stroke';
import { circleStroke, rectStroke, rotatePoints, topViewProjector } from './test-helpers';
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

  it('uses an optional world-distance threshold without changing the screen default', () => {
    const sketch = floorSketch();
    const start = snapAt(v3(500, 500, 0), sketch);
    const session = new StrokeSession(plane, start);
    const near = snapAt(v3(502, 500, 0), sketch);
    expect(session.add(near, near.raw, projector.project(v3(502, 500, 0))!, 2, 10)).toBe(false);
    const far = snapAt(v3(530, 500, 0), sketch);
    expect(session.add(far, far.raw, projector.project(v3(530, 500, 0))!, 2, 10)).toBe(true);
    expect(session.worldExtent()).toBeGreaterThan(20);
  });

  it('drops samples that barely moved on screen', () => {
    const sketch = floorSketch();
    const start = snapAt(v3(500, 500, 0), sketch);
    const session = new StrokeSession(plane, start);
    const snap = snapAt(v3(505, 500, 0), sketch);
    expect(session.add(snap, snap.raw, projector.project(v3(505, 500, 0))!)).toBe(false);
    expect(session.pointCount).toBe(2);
  });

  it('bumps the revision when onPlane, raw or plane coordinates change', () => {
    const sketch = floorSketch();
    const start = snapAt(v3(500, 500, 0), sketch);
    const session = new StrokeSession(plane, start);
    const base: SnapResult = {
      type: 'grid',
      world: v3(1000, 500, 0),
      plane: v2(1000, 500),
      screen: v2(0, 0),
      onPlane: true,
      raw: v3(1010, 500, 0),
    };
    const deltas: number[] = [];
    let previous = session.revision;
    const addVariant = (snap: SnapResult, x: number) => {
      session.add(snap, snap.raw, v2(x, 0));
      deltas.push(session.revision - previous);
      previous = session.revision;
    };
    addVariant(base, 40);
    addVariant({ ...base }, 80);
    addVariant({ ...base, raw: v3(990, 500, 0) }, 120);
    addVariant({ ...base, onPlane: false }, 160);
    addVariant({ ...base, plane: v2(999, 500) }, 200);
    addVariant({ ...base, raw: null }, 240);
    expect(deltas).toEqual([2, 1, 2, 2, 2, 2]);
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

describe('StrokeSession.revision', () => {
  const fakeSnap = (world: Vec3, type: SnapResult['type'] = 'free'): SnapResult => ({
    type,
    world,
    plane: plane.toPlane(world),
    screen: projector.project(world)!,
    onPlane: true,
    raw: world,
  });

  it('increments on accepted samples and endpoint snap changes, even without a sample', () => {
    const session = new StrokeSession(plane, fakeSnap(v3(500, 500, 0)));
    expect(session.revision).toBe(0);

    const nearby = fakeSnap(v3(510, 510, 0), 'vertex');
    expect(session.add(nearby, nearby.world, projector.project(v3(505, 505, 0))!)).toBe(false);
    expect(session.revision).toBe(1);

    expect(session.add(nearby, nearby.world, projector.project(v3(506, 505, 0))!)).toBe(false);
    expect(session.revision).toBe(1);

    const far = fakeSnap(v3(1500, 1500, 0));
    expect(session.add(far, far.world, far.screen)).toBe(true);
    expect(session.revision).toBeGreaterThan(1);
    const after = session.revision;
    const farther = fakeSnap(v3(1600, 1500, 0), 'edge');
    session.add(farther, farther.world, farther.screen);
    expect(session.revision).toBeGreaterThan(after);
  });
});

describe('resolveStroke', () => {
  const commitContext = (sketch: Sketch) => ({
    projector,
    vertices: sketch.vertices(),
    entities: sketch.all,
    tolerancePx: 14,
  });

  function strokeThrough(points: Vec3[], endType: SnapResult['type'] = 'free'): StrokeSession {
    const session = new StrokeSession(plane, snapAt(points[0], floorSketch()));
    for (let i = 1; i < points.length; i++) {
      const world = points[i];
      const snap: SnapResult = {
        type: i === points.length - 1 ? endType : 'free',
        world,
        plane: plane.toPlane(world),
        screen: projector.project(world)!,
        onPlane: true,
        raw: world,
      };
      session.add(snap, world, snap.screen);
    }
    return session;
  }

  it('returns a ready line for an ordinary straight stroke', () => {
    const sketch = floorSketch();
    const session = strokeThrough([v3(9000, 100, 0), v3(9500, 100, 0), v3(9500, 100, 0), v3(9800, 100, 0)]);
    const resolution = resolveStroke(session, commitContext(sketch));
    expect(resolution.status).toBe('ready');
    if (resolution.status !== 'ready') return;
    expect(resolution.input).toEqual({ type: 'line', a: v3(9000, 100, 0), b: v3(9800, 100, 0) });
    expect(resolution.removeIds).toEqual([]);
  });

  it('resolves a hard axis lock as a constrained line without touching raw samples', () => {
    const sketch = floorSketch();
    const start: SnapResult = { type: 'free', world: v3(0, 0, 0), plane: v2(0, 0), screen: projector.project(v3(0, 0, 0))!, onPlane: true, raw: v3(0, 0, 0) };
    const session = new StrokeSession(plane, start);
    for (let i = 1; i <= 12; i++) {
      const world = v3((1234 * i) / 12, (700 * i) / 12, 0);
      const snap: SnapResult = { type: 'free', world, plane: plane.toPlane(world), screen: projector.project(world)!, onPlane: true, raw: world };
      session.add(snap, world, snap.screen);
    }
    const middle = session.planePoints().slice(1, -1);
    const count = session.pointCount;
    expect(count).toBeGreaterThanOrEqual(12);

    const endScreen = projector.project(v3(1234, 700, 0))!;
    const locked: SnapResult = { type: 'lock', world: v3(1234, 0, 0), plane: v2(1234, 0), screen: endScreen, onPlane: true, raw: v3(1234, 700, 0), axis: 'x' };
    expect(session.add(locked, locked.raw, endScreen)).toBe(false);
    const resolution = resolveStroke(session, commitContext(sketch));
    expect(resolution.status).toBe('ready');
    if (resolution.status === 'ready') {
      expect(resolution.reason).toBe('axis-locked line');
      expect(resolution.input).toEqual({ type: 'line', a: v3(0, 0, 0), b: v3(1234, 0, 0) });
    }
    expect(session.planePoints().slice(1, -1)).toEqual(middle);
    expect(session.pointCount).toBe(count);

    const freed: SnapResult = { type: 'free', world: v3(1234, 700, 0), plane: v2(1234, 700), screen: endScreen, onPlane: true, raw: v3(1234, 700, 0) };
    expect(session.add(freed, freed.raw, endScreen)).toBe(false);
    const restored = resolveStroke(session, commitContext(sketch));
    expect(restored.status).toBe('ready');
    if (restored.status === 'ready') {
      expect(restored.input).toEqual({ type: 'line', a: v3(0, 0, 0), b: v3(1234, 700, 0) });
    }
    expect(session.planePoints().slice(1, -1)).toEqual(middle);
    expect(session.pointCount).toBe(count);
  });

  it('keeps the exact off-plane endpoint of a locked Z line', () => {
    const sketch = floorSketch();
    const start: SnapResult = { type: 'free', world: v3(0, 0, 0), plane: v2(0, 0), screen: projector.project(v3(0, 0, 0))!, onPlane: true, raw: v3(0, 0, 0) };
    const session = new StrokeSession(plane, start);
    const middle = v3(400, 200, 0);
    const snap: SnapResult = { type: 'free', world: middle, plane: plane.toPlane(middle), screen: projector.project(middle)!, onPlane: true, raw: middle };
    session.add(snap, middle, snap.screen);
    const locked: SnapResult = { type: 'lock', world: v3(0, 0, 2500), plane: v2(0, 0), screen: snap.screen, onPlane: false, raw: middle, axis: 'z' };
    expect(session.add(locked, locked.raw, snap.screen)).toBe(false);
    const resolution = resolveStroke(session, commitContext(sketch));
    expect(resolution.status).toBe('ready');
    if (resolution.status !== 'ready') return;
    expect(resolution.input).toEqual({ type: 'line', a: v3(0, 0, 0), b: v3(0, 0, 2500) });
  });

  it('aligns a rough same-size adjacent rectangle to the whole shared border', () => {
    const sketch = floorSketch();
    const start: SnapResult = { type: 'free', world: v3(4100, 500, 0), plane: v2(4100, 500), screen: projector.project(v3(4100, 500, 0))!, onPlane: true, raw: v3(4100, 500, 0) };
    const session = new StrokeSession(plane, start);
    for (const p of rectStroke(4100, 500, 3700, 2000, { pointsPerSide: 25 }).slice(1)) {
      const world = v3(p.x, p.y, 0);
      const snap: SnapResult = { type: 'free', world, plane: p, screen: projector.project(world)!, onPlane: true, raw: world };
      session.add(snap, world, snap.screen);
    }
    const pathBefore = session.planePoints();
    const resolution = resolveStroke(session, { ...commitContext(sketch), tolerancePx: 22 });
    expect(resolution.status).toBe('ready');
    if (resolution.status !== 'ready') return;
    expect(resolution.input.type).toBe('rect');
    if (resolution.input.type !== 'rect') return;
    const expected = [v3(4000, 0, 0), v3(8000, 0, 0), v3(8000, 3000, 0), v3(4000, 3000, 0)];
    expect(sameRectangle(resolution.input.corners, expected)).toBe(true);
    expect(resolution.input.corners).toEqual(expected);
    expect(session.planePoints()).toEqual(pathBefore);
    const floor = sketch.all[0];
    expect(floor.type).toBe('rect');
    if (floor.type === 'rect') expect(floor.corners).toEqual(makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000));
  });

  it('reports unrecognized strokes without a completion', () => {
    const sketch = floorSketch();
    const session = strokeThrough([v3(500, 500, 0), v3(900, 800, 0), v3(600, 1200, 0), v3(1100, 700, 0)]);
    const resolution = resolveStroke(session, commitContext(sketch));
    expect(resolution.status).toBe('unrecognized');
    expect(resolution.input).toBeNull();
    expect(resolution.removeIds).toEqual([]);
  });

  it('completes a three-sided stroke snapped to a shared border', () => {
    const sketch = floorSketch();
    const session = strokeThrough(
      [v3(4000, 0, 0), v3(5500, 0, 0), v3(7000, 0, 0), v3(7000, 1500, 0), v3(7000, 3000, 0), v3(5500, 3000, 0), v3(4000, 3000, 0)],
      'vertex',
    );
    const start: SnapResult = { ...session.start, type: 'vertex', entityId: 'e1' };
    const withStart = new StrokeSession(plane, start);
    for (const world of [v3(5500, 0, 0), v3(7000, 0, 0), v3(7000, 1500, 0), v3(7000, 3000, 0), v3(5500, 3000, 0)]) {
      const snap: SnapResult = { type: 'free', world, plane: plane.toPlane(world), screen: projector.project(world)!, onPlane: true, raw: world };
      withStart.add(snap, world, snap.screen);
    }
    const end: SnapResult = { type: 'vertex', world: v3(4000, 3000, 0), plane: v2(4000, 3000), screen: projector.project(v3(4000, 3000, 0))!, onPlane: true, raw: v3(4000, 3000, 0), entityId: 'e1' };
    withStart.add(end, v3(4000, 3000, 0), end.screen);
    const resolution = resolveStroke(withStart, commitContext(sketch));
    expect(resolution.status).toBe('ready');
    if (resolution.status !== 'ready') return;
    expect(resolution.reason).toBe('shared-border rectangle');
    expect(resolution.input.type).toBe('rect');
    expect(resolution.removeIds).toEqual([]);
  });

  it('flags a duplicate when the completed rectangle already exists', () => {
    const sketch = floorSketch();
    sketch.addEntity({ type: 'rect', corners: makeRect(v3(4000, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 3000, 3000) });
    const session = strokeThrough(
      [v3(4000, 0, 0), v3(5500, 0, 0), v3(7000, 0, 0), v3(7000, 1500, 0), v3(7000, 3000, 0), v3(5500, 3000, 0), v3(4000, 3000, 0)],
      'vertex',
    );
    const start: SnapResult = { ...session.start, type: 'vertex', entityId: 'e1' };
    const withStart = new StrokeSession(plane, start);
    for (const world of [v3(5500, 0, 0), v3(7000, 0, 0), v3(7000, 1500, 0), v3(7000, 3000, 0), v3(5500, 3000, 0)]) {
      const snap: SnapResult = { type: 'free', world, plane: plane.toPlane(world), screen: projector.project(world)!, onPlane: true, raw: world };
      withStart.add(snap, world, snap.screen);
    }
    const end: SnapResult = { type: 'vertex', world: v3(4000, 3000, 0), plane: v2(4000, 3000), screen: projector.project(v3(4000, 3000, 0))!, onPlane: true, raw: v3(4000, 3000, 0), entityId: 'e2' };
    withStart.add(end, v3(4000, 3000, 0), end.screen);
    const resolution = resolveStroke(withStart, commitContext(sketch));
    expect(resolution.status).toBe('duplicate');
    expect(resolution.reason).toBe('rectangle already exists');
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
