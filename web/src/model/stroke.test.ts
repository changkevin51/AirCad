import { describe, expect, it } from 'vitest';
import { WorkPlane, type PlaneKind } from './plane';
import { snapCursor, type SnapResult } from './snap';
import { makeRect, Sketch } from './sketch';
import {
  alignRectToStart,
  anchorAfterCommit,
  buildEntityFromStroke,
  pullRectCorners,
  StrokeSession,
} from './stroke';
import { circleStroke, rectStroke, topViewProjector, triangleStroke } from './test-helpers';
import { add, dot, normalize, scale, sub, v2, v3, type Vec2, type Vec3 } from './vec';

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

describe('StrokeSession: closed outlines', () => {
  it.each(['XY', 'XZ', 'YZ'] as const)('recognises a raw closed round stroke on %s as a rectangle on the real plane', (kind) => {
    const outlinePlane = new WorkPlane(kind, v3(100, 200, 300));
    const raw = circleStroke(700, 800, 250, 60);
    const snapFor = (p: Vec2): SnapResult => ({
      type: 'grid',
      world: outlinePlane.toWorld(v2(p.x + 100, p.y + 100)),
      plane: v2(p.x + 100, p.y + 100),
      screen: v2(p.x / 2, p.y / 2),
      onPlane: true,
      raw: outlinePlane.toWorld(p),
    });
    const session = new StrokeSession(outlinePlane, snapFor(raw[0]));
    for (const p of raw.slice(1)) {
      session.add(snapFor(p), outlinePlane.toWorld(p), v2(p.x / 2, p.y / 2), 0);
    }
    const result = session.recognize();
    expect(result.shape?.kind).toBe('rect');
    if (result.shape?.kind !== 'rect') return;
    const entity = buildEntityFromStroke(session, result.shape, { projector, vertices: [], tolerancePx: 14, gridStep: 0 });
    expect(entity.type).toBe('rect');
    if (entity.type !== 'rect') return;
    expect(entity.corners).toHaveLength(4);
    for (const corner of entity.corners) expect(outlinePlane.contains(corner)).toBe(true);
    const local = entity.corners.map((corner) => outlinePlane.toPlane(corner));
    const cx = local.reduce((s, p) => s + p.x, 0) / 4;
    const cy = local.reduce((s, p) => s + p.y, 0) / 4;
    expect(Math.hypot(cx - 700, cy - 800)).toBeLessThan(20);
    const width = Math.max(...local.map((p) => p.x)) - Math.min(...local.map((p) => p.x));
    const height = Math.max(...local.map((p) => p.y)) - Math.min(...local.map((p) => p.y));
    expect(Math.max(width, height)).toBeGreaterThan(450);
    expect(Math.max(width, height)).toBeLessThan(800);
    expect(anchorAfterCommit(entity)).toEqual(entity.corners[0]);
  });

  it('keeps an incomplete arc unrecognized even when grid-only snapped endpoints coincide', () => {
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
    expect(session.recognize().shape).toBeNull();
  });

  it('lets an explicit on-plane object snap close an open outline', () => {
    const points = circleStroke(700, 800, 250).slice(0, 61);
    const workPlane = new WorkPlane('XY');
    const snapFor = (raw: Vec2, overrides: Partial<SnapResult> = {}): SnapResult => ({
      type: 'grid', world: workPlane.toWorld(raw), plane: raw,
      screen: v2(raw.x / 2, raw.y / 2), onPlane: true, raw: workPlane.toWorld(raw),
      ...overrides,
    });
    const session = new StrokeSession(workPlane, snapFor(points[0]));
    points.slice(1).forEach((point, index) => {
      const closing = index === points.length - 2
        ? { type: 'vertex' as const, world: workPlane.toWorld(points[0]), plane: points[0] }
        : {};
      const snap = snapFor(point, closing);
      session.add(snap, snap.raw, snap.screen, 0);
    });
    const result = session.recognize();
    expect(result.shape?.kind).toBe('rect');
  });
});

describe('StrokeSession: line measurement', () => {
  const origin = v3(100, 200, 300);

  const snapFor = (workPlane: WorkPlane, world: Vec3, overrides: Partial<SnapResult> = {}): SnapResult => ({
    type: 'free',
    world,
    plane: workPlane.toPlane(world),
    screen: workPlane.toPlane(world),
    onPlane: workPlane.contains(world),
    raw: world,
    ...overrides,
  });

  const sessionOn = (kind: PlaneKind): { plane: WorkPlane; session: StrokeSession } => {
    const workPlane = new WorkPlane(kind, origin);
    const session = new StrokeSession(workPlane, snapFor(workPlane, origin));
    return { plane: workPlane, session };
  };

  it('waits for 32 screen pixels before offering a voice direction', () => {
    const { plane: workPlane, session } = sessionOn('XY');
    for (const x of [5, 20, 31]) {
      const point = add(origin, v3(x, 0, 0));
      session.add(snapFor(workPlane, point), point, workPlane.toPlane(point), 0);
      expect(session.measurement).toBeNull();
    }
    const point = add(origin, v3(32, 0, 0));
    session.add(snapFor(workPlane, point), point, workPlane.toPlane(point), 0);
    expect(session.measurement!.direction).toEqual(v3(1, 0, 0));
  });

  it('refines the signed direction as the user steers without mutating prior measurements', () => {
    const { plane: workPlane, session } = sessionOn('XY');
    const first = v3(130, 240, 300);
    session.add(snapFor(workPlane, first), first, workPlane.toPlane(first), 0);
    const initial = session.measurement!;
    expect(initial.direction.x).toBeCloseTo(0.6);
    expect(initial.direction.y).toBeCloseTo(0.8);
    expect(initial.previewLength).toBeCloseTo(50);
    const second = v3(100, 260, 300);
    session.add(snapFor(workPlane, second), second, workPlane.toPlane(second), 0);
    expect(session.measurement!.direction.x).toBeLessThan(initial.direction.x);
    expect(session.measurement!.direction.y).toBeGreaterThan(initial.direction.y);
    for (let i = 7; i <= 18; i += 1) {
      const point = add(origin, v3(0, i * 10, 0));
      session.add(snapFor(workPlane, point), point, workPlane.toPlane(point), 0);
    }
    expect(session.measurement!.direction.y).toBeCloseTo(1);
    expect(session.measurement!.direction.x).toBeCloseTo(0);
    expect(session.measurement!.previewLength).toBeCloseTo(180);
    expect(session.measurement!.start).toEqual(origin);
    expect(initial.direction.x).toBeCloseTo(0.6);
    expect(initial.direction.y).toBeCloseTo(0.8);
  });

  it.each(['XY', 'XZ', 'YZ'] as const)('forgets initial wobble and preserves the plane offset on %s', (kind) => {
    const { plane: workPlane, session } = sessionOn(kind);
    const wobble = add(origin, add(scale(workPlane.u, 4), scale(workPlane.v, 20)));
    session.add(snapFor(workPlane, wobble), wobble, workPlane.toPlane(wobble), 0);
    for (let i = 1; i <= 12; i += 1) {
      const point = add(origin, add(scale(workPlane.u, 30 + 3 * i), scale(workPlane.v, 40 + 4 * i)));
      session.add(snapFor(workPlane, point), point, workPlane.toPlane(point), 0);
    }
    const measurement = session.measurement!;
    expect(dot(measurement.direction, workPlane.u)).toBeCloseTo(0.6, 9);
    expect(dot(measurement.direction, workPlane.v)).toBeCloseTo(0.8, 9);
    expect(dot(measurement.direction, workPlane.normal)).toBe(0);
    expect(measurement.start).toEqual(origin);
    expect(measurement.previewLength).toBeCloseTo(110, 9);
  });

  it('damps a final jitter sample and does not reweight repeated stationary frames', () => {
    const { plane: workPlane, session } = sessionOn('XY');
    const direction = v3(0.6, 0.8, 0);
    const perpendicular = v3(-0.8, 0.6, 0);
    for (let i = 0; i < 12; i += 1) {
      const point = add(origin, add(scale(direction, 100), scale(perpendicular, i % 2 ? 3 : -3)));
      session.add(snapFor(workPlane, point), point, workPlane.toPlane(point));
    }
    const jitter = add(origin, add(scale(direction, 100), scale(perpendicular, 12)));
    session.add(snapFor(workPlane, jitter), jitter, workPlane.toPlane(jitter));
    const before = session.measurement!;
    expect(Math.abs(dot(before.direction, perpendicular))).toBeLessThan(0.02);
    expect(Math.abs(dot(normalize(sub(jitter, origin)), perpendicular))).toBeGreaterThan(0.1);
    const count = session.pointCount;
    for (let i = 0; i < 50; i += 1) session.add(snapFor(workPlane, jitter), jitter, workPlane.toPlane(jitter));
    expect(session.pointCount).toBe(count);
    expect(session.measurement).toEqual(before);
  });

  it.each(['axis', 'grid'] as const)('keeps a near-axis free angle despite an automatic %s snap', (type) => {
    const { plane: workPlane, session } = sessionOn('XY');
    const raw = add(origin, v3(100, 7, 0));
    const snapped = add(origin, v3(100, 0, 0));
    session.add(snapFor(workPlane, snapped, { type, axis: 'u', raw }), raw, workPlane.toPlane(raw), 0);
    const direction = session.measurement!.direction;
    expect(direction.y / direction.x).toBeCloseTo(0.07, 9);
  });

  it('lets a later explicit lock or on-plane object snap override the smoothed aim exactly', () => {
    const { plane: workPlane, session } = sessionOn('XY');
    const first = add(origin, v3(30, 40, 0));
    session.add(snapFor(workPlane, first), first, workPlane.toPlane(first), 0);
    const raw = add(origin, v3(60, 25, 0));
    const locked = add(origin, v3(60, 0, 0));
    session.add(snapFor(workPlane, locked, { type: 'lock', axis: 'x', raw }), raw, workPlane.toPlane(raw), 0);
    expect(session.measurement!.direction).toEqual(v3(1, 0, 0));
    expect(session.measurement!.previewLength).toBeCloseTo(60);
    const vertex = add(origin, v3(60, 80, 0));
    session.add(snapFor(workPlane, vertex, { type: 'vertex', raw }), raw, v2(160, 280), 0);
    expect(session.measurement!.direction.x).toBeCloseTo(0.6);
    expect(session.measurement!.direction.y).toBeCloseTo(0.8);
    expect(session.measurement!.previewLength).toBeCloseTo(100);
    const offPlane = add(origin, v3(0, 0, 50));
    session.add(snapFor(workPlane, offPlane, { type: 'lock', axis: 'z' }), offPlane, v2(160, 280), 0);
    expect(session.measurement).toBeNull();
  });

  it('preserves a deliberate reversed direction and rejects invalid current hits', () => {
    const { plane: workPlane, session } = sessionOn('XY');
    for (const offset of [v3(60, 80, 0), v3(-60, -80, 0)]) {
      const point = add(origin, offset);
      session.add(snapFor(workPlane, point), point, workPlane.toPlane(point), 0);
    }
    expect(session.measurement!.direction.x).toBeCloseTo(-0.6);
    expect(session.measurement!.direction.y).toBeCloseTo(-0.8);
    const invalid = v3(NaN, 280, 300);
    session.add(snapFor(workPlane, invalid), invalid, v2(160, 280), 0);
    expect(session.measurement).toBeNull();
  });

  it.each(['XZ', 'YZ'] as const)('measures a pure world-Z direction at a nonzero %s offset', (kind) => {
    const { plane: workPlane, session } = sessionOn(kind);
    const end = add(origin, scale(workPlane.v, 40));
    session.add(snapFor(workPlane, end), end, workPlane.toPlane(end), 0);
    const measurement = session.measurement!;
    expect(measurement.plane).toBe(kind);
    expect(measurement.direction).toEqual(workPlane.v);
    expect(measurement.start).toEqual(origin);
    expect(measurement.start[workPlane.info.normalAxis]).toBeCloseTo(origin[workPlane.info.normalAxis]);
    expect(measurement.previewLength).toBeCloseTo(40);
  });

  it('rejects an off-plane hard axis lock as a direction', () => {
    const { plane: workPlane, session } = sessionOn('XY');
    const locked = v3(100, 200, 340);
    session.add(snapFor(workPlane, locked, { type: 'lock', axis: 'z' }), locked, v2(100, 240), 0);
    expect(session.measurement).toBeNull();
    const inPlane = v3(140, 200, 300);
    session.add(snapFor(workPlane, inPlane), inPlane, v2(140, 200), 0);
    expect(session.measurement!.direction).toEqual(v3(1, 0, 0));
  });

  it('does not quantize the direction to a grid-only snap', () => {
    const { plane: workPlane, session } = sessionOn('XY');
    const raw = v3(130, 240, 300);
    session.add(snapFor(workPlane, v3(200, 200, 300), { type: 'grid', raw }), raw, v2(130, 240), 0);
    const direction = session.measurement!.direction;
    expect(direction.x).toBeCloseTo(0.6);
    expect(direction.y).toBeCloseTo(0.8);
    expect(direction.z).toBeCloseTo(0);
    expect(direction.x).not.toBeCloseTo(1);
  });

  it('uses the in-plane ray hit of an off-plane object snap without moving the line off the plane', () => {
    const { plane: workPlane, session } = sessionOn('XY');
    const rayHit = v3(160, 200, 300);
    const vertex = snapFor(workPlane, v3(160, 200, 2500), { type: 'vertex', onPlane: false });
    session.add(vertex, rayHit, v2(160, 200), 0);
    const measurement = session.measurement!;
    expect(measurement.direction).toEqual(v3(1, 0, 0));
    expect(measurement.start).toEqual(origin);
    expect(measurement.start.z).toBe(300);
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

  it('fits the nearest compatible existing edge before grid or vertex correction', () => {
    const sketch = new Sketch();
    const target = sketch.addEntity({ type: 'line', a: v3(100, 130, 0), b: v3(500, 130, 0) });
    const shape = triangleShape([v2(100, 100), v2(500, 100), v2(250, 400)]);
    const session = new StrokeSession(plane, freeStart(shape.corners[0]));
    const entity = buildEntityFromStroke(session, shape, {
      projector,
      vertices: sketch.vertices(),
      tolerancePx: 40,
      gridStep: 100,
      entities: sketch.all,
    });
    if (entity.type !== 'triangle') throw new Error('unreachable');
    expect(entity.corners[0]).toEqual(v3(100, 130, 0));
    expect(entity.corners[1]).toEqual(v3(500, 130, 0));
    expect(Math.hypot(entity.corners[1].x - entity.corners[0].x, entity.corners[1].y - entity.corners[0].y)).toBeCloseTo(400, 6);
    expect(target).toEqual({ id: target.id, type: 'line', a: v3(100, 130, 0), b: v3(500, 130, 0) });
  });

  it('keeps an explicit object-snapped start corner in place when edge contact would move it', () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'line', a: v3(100, 130, 0), b: v3(500, 130, 0) });
    const shape = triangleShape([v2(100, 100), v2(500, 100), v2(250, 400)]);
    const start = freeStart(shape.corners[0], 'vertex', v3(100, 100, 0));
    const session = new StrokeSession(plane, start);
    const entity = buildEntityFromStroke(session, shape, {
      projector,
      vertices: sketch.vertices(),
      tolerancePx: 40,
      gridStep: 0,
      entities: sketch.all,
    });
    if (entity.type !== 'triangle') throw new Error('unreachable');
    expect(entity.corners[0]).toEqual(v3(100, 100, 0));
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
