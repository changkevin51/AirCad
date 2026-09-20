import { describe, expect, it } from 'vitest';
import { joinEndpoints, shouldCloseLoop, snapLineToSegments, snapTriangleToSegments } from './spatial-join';
import { WorkPlane } from './plane';
import { topViewProjector } from './test-helpers';
import { distance } from './vec';
import { v3 } from './vec';

describe('joinEndpoints', () => {
  it('pulls line endpoints onto nearby vertices', () => {
    const joined = joinEndpoints(
      { type: 'line', a: v3(35, 0, 0), b: v3(4030, 8, 4) },
      {
        vertices: [
          { point: v3(0, 0, 0), entityId: 'a', index: 0 },
          { point: v3(4000, 0, 0), entityId: 'b', index: 1 },
        ],
      },
      40,
    );
    expect(joined).toEqual({ type: 'line', a: v3(0, 0, 0), b: v3(4000, 0, 0) });
  });

  it('moves whole rectangle edges so the result stays a rectangle', () => {
    const joined = joinEndpoints(
      {
        type: 'rect',
        corners: [v3(12, 0, 0), v3(2010, 0, 0), v3(2010, 1500, 0), v3(12, 1500, 0)],
      },
      {
        vertices: [
          { point: v3(0, 0, 0), entityId: 'a', index: 0 },
          { point: v3(2000, 0, 0), entityId: 'b', index: 1 },
        ],
      },
      40,
    );
    expect(joined.type).toBe('rect');
    if (joined.type === 'rect') {
      expect(joined.corners[0].x).toBeCloseTo(0, 1);
      expect(joined.corners[0].y).toBeCloseTo(0, 1);
      expect(joined.corners[1].x).toBeCloseTo(2000, 1);
      expect(joined.corners[1].y).toBeCloseTo(0, 1);
      const width = Math.hypot(joined.corners[1].x - joined.corners[0].x, joined.corners[1].y - joined.corners[0].y);
      const height = Math.hypot(joined.corners[3].x - joined.corners[0].x, joined.corners[3].y - joined.corners[0].y);
      expect(width).toBeGreaterThan(1000);
      expect(height).toBeGreaterThan(1000);
    }
  });

  it('closes a loop when pen-up is within the magnet radius of start', () => {
    expect(shouldCloseLoop(v3(0, 0, 0), v3(30, 8, 4), 40)).toBe(true);
    expect(shouldCloseLoop(v3(0, 0, 0), v3(80, 0, 0), 40)).toBe(false);
  });

  it('joins an endpoint onto a nearby midpoint', () => {
    const joined = joinEndpoints(
      { type: 'line', a: v3(0, 200, 0), b: v3(18, 8, 0) },
      {
        vertices: [],
        midpoints: [{ point: v3(0, 0, 0), entityId: 'a', index: 0 }],
      },
      40,
    );
    expect(joined).toEqual({ type: 'line', a: v3(0, 200, 0), b: v3(0, 0, 0) });
  });

  it('keeps the constrained direction when joining an edge', () => {
    const joined = joinEndpoints(
      { type: 'line', a: v3(0, 0, 0), b: v3(1000, 0, 0) },
      {
        vertices: [],
        segments: [{ a: v3(990, 10, 0), b: v3(1010, 30, 0), entityId: 'wall', index: 0 }],
      },
      40,
    );
    expect(joined.type).toBe('line');
    if (joined.type === 'line') {
      expect(joined.a).toEqual(v3(0, 0, 0));
      expect(joined.b.y).toBeCloseTo(0, 5);
      expect(joined.b.z).toBeCloseTo(0, 5);
      expect(joined.b.x).toBeGreaterThan(900);
    }
  });
});

describe('snapLineToSegments', () => {
  const diagonal = (() => {
    const angle = (38 * Math.PI) / 180;
    return { a: v3(0, 0, 0), b: v3(Math.cos(angle) * 1000, Math.sin(angle) * 1000, 0), entityId: 'diag', index: 0 };
  })();

  it('adopts a nearby 38° diagonal as a parallel line', () => {
    const drawnAngle = (46 * Math.PI) / 180;
    const a = v3(0, 80, 0);
    const b = v3(a.x + Math.cos(drawnAngle) * 500, a.y + Math.sin(drawnAngle) * 500, 0);
    const snapped = snapLineToSegments(a, b, [diagonal], { radius: 40 });
    expect(snapped.mode).toBe('parallel');
    const angle = (Math.atan2(snapped.b.y - snapped.a.y, snapped.b.x - snapped.a.x) * 180) / Math.PI;
    expect(angle).toBeCloseTo(38, 4);
    expect(snapped.a).toEqual(a);
    expect(distance(snapped.a, snapped.b)).toBeCloseTo(500, 5);
  });

  it('makes the line collinear when the offset is inside the snap radius', () => {
    const drawnAngle = (40 * Math.PI) / 180;
    const a = v3(0, 20, 0);
    const b = v3(a.x + Math.cos(drawnAngle) * 400, a.y + Math.sin(drawnAngle) * 400, 0);
    const snapped = snapLineToSegments(a, b, [diagonal], { radius: 40 });
    expect(snapped.mode).toBe('collinear');
    expect(Math.abs(snapped.a.y - Math.tan((38 * Math.PI) / 180) * snapped.a.x)).toBeCloseTo(0, 4);
  });

  it('keeps a parallel offset when the line is outside the snap radius', () => {
    const drawnAngle = (40 * Math.PI) / 180;
    const a = v3(0, 80, 0);
    const b = v3(a.x + Math.cos(drawnAngle) * 400, a.y + Math.sin(drawnAngle) * 400, 0);
    const snapped = snapLineToSegments(a, b, [diagonal], { radius: 40 });
    expect(snapped.mode).toBe('parallel');
    expect(snapped.a).toEqual(a);
  });

  it('snaps perpendicular from an edge start', () => {
    const snapped = snapLineToSegments(
      v3(200, 8, 0),
      v3(220, 508, 12),
      [{ a: v3(0, 0, 0), b: v3(1000, 0, 0), entityId: 'floor', index: 0 }],
      { radius: 40, plane: 'XY', startOnSegmentId: 'floor' },
    );
    expect(snapped.mode).toBe('perpendicular');
    expect(snapped.a.y).toBeCloseTo(0, 5);
    expect(snapped.b.x).toBeCloseTo(snapped.a.x, 5);
    expect(snapped.b.y).toBeGreaterThan(400);
  });
});

describe('pullRectCornersWorld segments', () => {
  it('moves a rectangle edge onto a nearby coplanar segment', () => {
    const joined = joinEndpoints(
      {
        type: 'rect',
        corners: [v3(12, 0, 0), v3(2012, 0, 0), v3(2012, 1500, 0), v3(12, 1500, 0)],
      },
      {
        vertices: [],
        segments: [{ a: v3(0, 0, 0), b: v3(0, 2000, 0), entityId: 'wall', index: 0 }],
      },
      40,
    );
    expect(joined.type).toBe('rect');
    if (joined.type === 'rect') {
      expect(joined.corners[0].x).toBeCloseTo(0, 1);
      expect(joined.corners[3].x).toBeCloseTo(0, 1);
      expect(joined.corners[1].x).toBeCloseTo(2012, 1);
    }
  });
});

describe('snapTriangleToSegments', () => {
  const plane = new WorkPlane('XY');
  const projector = topViewProjector(1, 0, 0);
  const triangle = [v3(100, 100, 0), v3(500, 100, 0), v3(250, 400, 0)] as const;
  const segment = (a: ReturnType<typeof v3>, b: ReturnType<typeof v3>, entityId: string, index = 0) => ({ a, b, entityId, index });

  it('rotates a nearby side to parallel while preserving the rigid triangle', () => {
    const rotated = [v3(100, 100, 0), v3(100 + Math.cos(Math.PI / 180 * 7) * 400, 100 + Math.sin(Math.PI / 180 * 7) * 400, 0), v3(250, 400, 0)] as const;
    const target = segment(v3(0, 150, 0), v3(600, 150, 0), 'parallel');
    const result = snapTriangleToSegments(rotated, [target], { plane, projector, tolerancePx: 20 });
    if (!result) throw new Error('expected a parallel fit');
    expect(result?.mode).toBe('parallel');
    expect(result?.angleDeg).toBeCloseTo(7, 6);
    expect(result?.corners[0].y).toBeCloseTo(result?.corners[1].y, 6);
    expect(result && distance(result.corners[0], result.corners[1])).toBeCloseTo(distance(rotated[0], rotated[1]), 6);
    expect(result && distance(result.corners[1], result.corners[2])).toBeCloseTo(distance(rotated[1], rotated[2]), 6);
  });

  it('moves the nearest side onto a nearby compatible edge when inside the snap radius', () => {
    const target = segment(v3(100, 130, 0), v3(500, 130, 0), 'contact');
    const result = snapTriangleToSegments(triangle, [target], { plane, projector, tolerancePx: 40 });
    expect(result?.mode).toBe('contact');
    expect(result?.corners[0]).toEqual(v3(100, 130, 0));
    expect(result?.corners[1]).toEqual(v3(500, 130, 0));
  });

  it('rejects perpendicular, far, and finite-disjoint targets', () => {
    expect(snapTriangleToSegments(triangle, [segment(v3(100, 130, 0), v3(100, 530, 0), 'perpendicular')], { plane, projector, tolerancePx: 40 })).toBeNull();
    expect(snapTriangleToSegments(triangle, [segment(v3(0, 500, 0), v3(600, 500, 0), 'far')], { plane, projector, tolerancePx: 40 })).toBeNull();
    expect(snapTriangleToSegments(triangle, [segment(v3(700, 100, 0), v3(900, 100, 0), 'extension')], { plane, projector, tolerancePx: 40 })).toBeNull();
    expect(snapTriangleToSegments(triangle, [segment(v3(500, 130, 0), v3(900, 130, 0), 'endpoint-only')], { plane, projector, tolerancePx: 40 })).toBeNull();
    expect(snapTriangleToSegments(triangle, [segment(v3(100, 130, 5), v3(500, 130, 5), 'off-plane')], { plane, projector, tolerancePx: 40 })).toBeNull();
  });

  it('chooses the closest compatible side before using angle as a tie-breaker', () => {
    const near = segment(v3(250, 90, 0), v3(500, 90 + Math.tan(Math.PI / 180 * 5) * 250, 0), 'near');
    const farther = segment(v3(50, 125, 0), v3(550, 125, 0), 'farther');
    const result = snapTriangleToSegments(triangle, [farther, near], { plane, projector, tolerancePx: 40 });
    expect(result?.entityId).toBe('near');
    expect(result?.angleDeg).toBeCloseTo(5, 6);
  });

  it.each(['XZ', 'YZ'] as const)('fits coplanar edges on the %s work plane', (kind) => {
    const workPlane = new WorkPlane(kind);
    const workProjector = {
      project: (world: ReturnType<typeof v3>) => {
        const point = workPlane.toPlane(world);
        return { x: point.x, y: -point.y };
      },
      ray: () => ({ origin: v3(0, 0, 1000), dir: v3(0, 0, -1) }),
    };
    const points = triangle.map((point) => workPlane.toWorld({ x: point.x, y: point.y }));
    const target = segment(workPlane.toWorld({ x: 100, y: 130 }), workPlane.toWorld({ x: 500, y: 130 }), 'plane-edge');
    const result = snapTriangleToSegments(points, [target], { plane: workPlane, projector: workProjector, tolerancePx: 40 });
    expect(result?.mode).toBe('contact');
    expect(result && workPlane.toPlane(result.corners[0]).y).toBeCloseTo(130, 6);
    expect(result && workPlane.toPlane(result.corners[1]).y).toBeCloseTo(130, 6);
  });

  it('supports rotated work-plane edges without mutating the target shape', () => {
    const angle = Math.PI / 6;
    const u = v3(Math.cos(angle), Math.sin(angle), 0);
    const n = v3(-Math.sin(angle), Math.cos(angle), 0);
    const addOffset = (point: ReturnType<typeof v3>, offset: number) => v3(point.x + n.x * offset, point.y + n.y * offset, point.z);
    const rotatedTriangle = [v3(100, 100, 0), v3(100 + u.x * 400, 100 + u.y * 400, 0), v3(250, 500, 0)] as const;
    const target = segment(addOffset(rotatedTriangle[0], 20), addOffset(rotatedTriangle[1], 20), 'rotated');
    const before = { a: { ...target.a }, b: { ...target.b }, entityId: target.entityId, index: target.index };
    const lengths = [distance(rotatedTriangle[0], rotatedTriangle[1]), distance(rotatedTriangle[1], rotatedTriangle[2]), distance(rotatedTriangle[2], rotatedTriangle[0])];
    const result = snapTriangleToSegments(rotatedTriangle, [target], { plane, projector, tolerancePx: 40 });
    expect(result?.mode).toBe('contact');
    expect(result && distance(result.corners[0], target.a)).toBeLessThan(1e-9);
    expect(result && distance(result.corners[1], target.b)).toBeLessThan(1e-9);
    expect(result && distance(result.corners[0], result.corners[1])).toBeCloseTo(lengths[0], 6);
    expect(result && distance(result.corners[1], result.corners[2])).toBeCloseTo(lengths[1], 6);
    expect(result && distance(result.corners[2], result.corners[0])).toBeCloseTo(lengths[2], 6);
    expect(target.a).toEqual(before.a);
    expect(target.b).toEqual(before.b);
  });
});
