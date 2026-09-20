import { describe, expect, it } from 'vitest';
import { joinEndpoints, shouldCloseLoop, snapLineToSegments } from './spatial-join';
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
