import { describe, expect, it } from 'vitest';
import { WorkPlane } from './plane';
import { snapCursor, type SnapResult } from './snap';
import { makeRect, Sketch } from './sketch';
import { alignRectToStart, anchorAfterCommit, buildEntityFromStroke, pullRectCorners, StrokeSession } from './stroke';
import { rectStroke, topViewProjector } from './test-helpers';
import { v2, v3, type Vec3 } from './vec';

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
