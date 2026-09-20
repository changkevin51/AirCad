import { describe, expect, it } from 'vitest';
import { recognizeStroke, simplifyRdp, type RecognizedRect } from './recognize';
import { circleStroke, lineStroke, rectStroke, rotatePoints, scribbleStroke, seededRandom } from './test-helpers';
import { v2, type Vec2 } from './vec';

function expectRectClose(rect: RecognizedRect, x0: number, y0: number, w: number, h: number, tolerance: number): void {
  const xs = rect.corners.map((c) => c.x);
  const ys = rect.corners.map((c) => c.y);
  expect(Math.min(...xs)).toBeCloseTo(x0, -Math.log10(tolerance));
  expect(Math.max(...xs)).toBeCloseTo(x0 + w, -Math.log10(tolerance));
  expect(Math.min(...ys)).toBeCloseTo(y0, -Math.log10(tolerance));
  expect(Math.max(...ys)).toBeCloseTo(y0 + h, -Math.log10(tolerance));
}

function roughBowedRectStroke(x0: number, y0: number, width: number, height: number): Vec2[] {
  const corners = [v2(x0, y0), v2(x0 + width, y0), v2(x0 + width, y0 + height), v2(x0, y0 + height)];
  const sideSamples = [17, 11, 23, 14];
  const cornerSamples = 4;
  const cornerRadius = Math.min(width, height) * 0.07;
  const bow = Math.min(width, height) * 0.045;
  const jitter = Math.min(width, height) * 0.018;
  const center = v2(x0 + width / 2, y0 + height / 2);
  const rand = seededRandom(23);
  const angle = 27 * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rotateAroundCenter = (point: Vec2): Vec2 => {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return v2(center.x + dx * cos - dy * sin, center.y + dx * sin + dy * cos);
  };
  const points: Vec2[] = [];
  for (let side = 0; side < corners.length; side++) {
    const corner = corners[side];
    const nextCorner = corners[(side + 1) % corners.length];
    const dx = nextCorner.x - corner.x;
    const dy = nextCorner.y - corner.y;
    const length = Math.hypot(dx, dy);
    const ux = dx / length;
    const uy = dy / length;
    const start = v2(corner.x + ux * cornerRadius, corner.y + uy * cornerRadius);
    const end = v2(nextCorner.x - ux * cornerRadius, nextCorner.y - uy * cornerRadius);
    for (let i = 0; i < sideSamples[side]; i++) {
      const t = i / (sideSamples[side] - 1);
      const sideOffset = bow * Math.sin(Math.PI * t);
      const point = v2(
        start.x + (end.x - start.x) * t - uy * sideOffset + (rand() - 0.5) * jitter,
        start.y + (end.y - start.y) * t + ux * sideOffset + (rand() - 0.5) * jitter,
      );
      points.push(rotateAroundCenter(point));
    }
    const nextDx = corners[(side + 2) % corners.length].x - nextCorner.x;
    const nextDy = corners[(side + 2) % corners.length].y - nextCorner.y;
    const nextLength = Math.hypot(nextDx, nextDy);
    const nextStart = v2(nextCorner.x + nextDx / nextLength * cornerRadius, nextCorner.y + nextDy / nextLength * cornerRadius);
    for (let i = 1; i < cornerSamples; i++) {
      const t = i / cornerSamples;
      const oneMinusT = 1 - t;
      const point = v2(
        oneMinusT * oneMinusT * end.x + 2 * oneMinusT * t * nextCorner.x + t * t * nextStart.x + (rand() - 0.5) * jitter,
        oneMinusT * oneMinusT * end.y + 2 * oneMinusT * t * nextCorner.y + t * t * nextStart.y + (rand() - 0.5) * jitter,
      );
      points.push(rotateAroundCenter(point));
    }
  }
  return points;
}

describe('recognizeStroke: lines', () => {
  it('recognises a clean straight line with exact endpoints', () => {
    const result = recognizeStroke(lineStroke(v2(0, 0), v2(3000, 1500)));
    expect(result.shape?.kind).toBe('line');
    if (result.shape?.kind !== 'line') return;
    expect(result.shape.a).toEqual(v2(0, 0));
    expect(result.shape.b).toEqual(v2(3000, 1500));
    expect(result.shape.alignedTo).toBeNull();
  });

  it('aligns nearly horizontal and vertical lines to the plane axes', () => {
    const horizontal = recognizeStroke(lineStroke(v2(100, 100), v2(4100, 300), 30, 15));
    expect(horizontal.shape?.kind).toBe('line');
    if (horizontal.shape?.kind === 'line') {
      expect(horizontal.shape.alignedTo).toBe('u');
      expect(horizontal.shape.b.y).toBe(horizontal.shape.a.y);
    }
    const vertical = recognizeStroke(lineStroke(v2(500, 0), v2(560, 2500), 30, 15));
    expect(vertical.shape?.kind).toBe('line');
    if (vertical.shape?.kind === 'line') {
      expect(vertical.shape.alignedTo).toBe('v');
      expect(vertical.shape.b.x).toBe(vertical.shape.a.x);
    }
  });

  it('keeps a 30 degree line unaligned', () => {
    const result = recognizeStroke(lineStroke(v2(0, 0), v2(1000, 577), 30, 5));
    expect(result.shape?.kind).toBe('line');
    if (result.shape?.kind === 'line') expect(result.shape.alignedTo).toBeNull();
  });

  it('tolerates hand jitter along a line', () => {
    const result = recognizeStroke(lineStroke(v2(0, 0), v2(2000, 0), 60, 60));
    expect(result.shape?.kind).toBe('line');
  });

  it('rejects a wavy open stroke', () => {
    const points = lineStroke(v2(0, 0), v2(2000, 0), 80).map((p, i) => v2(p.x, p.y + Math.sin(i / 4) * 300));
    const result = recognizeStroke(points);
    expect(result.shape).toBeNull();
    expect(result.reason).toBe('open stroke');
  });
});

describe('recognizeStroke: rectangles', () => {
  it('recognises jittered, bowed, softened and rotated rectangles', () => {
    const strokes = [
      rectStroke(0, 0, 1000, 1000, { pointsPerSide: 12, jitter: 80 }),
      rectStroke(0, 0, 1000, 1000, { pointsPerSide: 8, jitter: 120, overshoot: 0.04 }),
      rotatePoints(rectStroke(0, 0, 1000, 1000, { pointsPerSide: 12, jitter: 80 }), 0.35, v2(500, 500)),
      rectStroke(0, 0, 1400, 800, { pointsPerSide: 12, jitter: 90, gapFraction: 0.005 }),
      roughBowedRectStroke(0, 0, 1000, 700),
    ];
    for (const stroke of strokes) expect(recognizeStroke(stroke).shape?.kind).toBe('rect');
  });

  it('does not force an open three-sided angular stroke into a rectangle', () => {
    const stroke = rectStroke(0, 0, 1000, 1000, { pointsPerSide: 12, jitter: 70, gapFraction: 0.2 });
    expect(recognizeStroke(stroke).shape).toBeNull();
  });

  it('snaps a closed circular loop to a rectangle', () => {
    const result = recognizeStroke(circleStroke(0, 0, 500));
    expect(result.shape?.kind).toBe('rect');
    if (result.shape?.kind !== 'rect') return;
    expect(result.shape.width).toBeCloseTo(1000, -2);
    expect(result.shape.height).toBeCloseTo(1000, -2);
  });

  it('recognises a clean axis-aligned rectangle', () => {
    const result = recognizeStroke(rectStroke(0, 0, 4000, 3000));
    expect(result.shape?.kind).toBe('rect');
    if (result.shape?.kind !== 'rect') return;
    expect(result.shape.oriented).toBe(false);
    expectRectClose(result.shape, 0, 0, 4000, 3000, 1);
    expect(result.shape.corners[0]).toEqual(v2(0, 0));
    expect(result.shape.width).toBeCloseTo(4000);
    expect(result.shape.height).toBeCloseTo(3000);
  });

  it('recognises a jittered, overshooting rectangle that starts mid-edge and is drawn clockwise', () => {
    const stroke = rectStroke(1000, 500, 3000, 2000, {
      jitter: 60,
      overshoot: 0.06,
      startFraction: 0.37,
      clockwise: true,
      gapFraction: 0.03,
    });
    const result = recognizeStroke(stroke);
    expect(result.reason).toBe('rectangle');
    if (result.shape?.kind !== 'rect') return;
    expectRectClose(result.shape, 1000, 500, 3000, 2000, 150);
    // corners[0] sits nearest to the stroke start, corners[1] follows the pen direction
    const start = stroke[0];
    const distances = result.shape.corners.map((c) => Math.hypot(c.x - start.x, c.y - start.y));
    expect(distances[0]).toBe(Math.min(...distances));
  });

  it('keeps the orientation of a clearly rotated rectangle', () => {
    const stroke = rotatePoints(rectStroke(0, 0, 2000, 1000, { jitter: 10 }), (30 * Math.PI) / 180, v2(1000, 500));
    const result = recognizeStroke(stroke);
    expect(result.reason).toBe('oriented rectangle');
    if (result.shape?.kind !== 'rect') return;
    expect(result.shape.width).toBeCloseTo(2000, -2);
    expect(result.shape.height).toBeCloseTo(1000, -2);
    const tilt = ((Math.abs(result.shape.angle) * 180) / Math.PI) % 90;
    expect(Math.min(tilt, 90 - tilt)).toBeCloseTo(30, 0);
  });

  it('squares up a slightly rotated rectangle', () => {
    const stroke = rotatePoints(rectStroke(0, 0, 2000, 1000), (6 * Math.PI) / 180, v2(1000, 500));
    const result = recognizeStroke(stroke);
    expect(result.shape?.kind).toBe('rect');
    if (result.shape?.kind === 'rect') expect(result.shape.oriented).toBe(false);
  });

  it('rejects triangles, scribbles and open loops', () => {
    const triangle = [v2(0, 0), v2(1000, 0), v2(500, 800), v2(0, 0)];
    expect(recognizeStroke(triangle).shape).toBeNull();
    expect(recognizeStroke(scribbleStroke()).shape).toBeNull();
    expect(recognizeStroke(rectStroke(0, 0, 1000, 1000, { gapFraction: 0.3 })).shape).toBeNull();
  });

  it('ignores tiny strokes and degenerate input', () => {
    expect(recognizeStroke([v2(0, 0), v2(0.4, 0.2)], { minSize: 5 }).reason).toBe('too small');
    expect(recognizeStroke([v2(3, 3)]).reason).toBe('too few points');
    expect(recognizeStroke([]).shape).toBeNull();
  });
});

describe('recognizeStroke: closed loops without corners', () => {
  it('still requires a closed stroke and rejects triangles, scribbles and short arcs', () => {
    const triangle = [v2(0, 0), v2(1000, 0), v2(500, 800), v2(0, 0)];
    expect(recognizeStroke(triangle).shape).toBeNull();
    expect(recognizeStroke(scribbleStroke()).shape).toBeNull();
    expect(recognizeStroke(rectStroke(0, 0, 1000, 1000, { gapFraction: 0.3 })).shape).toBeNull();
    const circle = circleStroke(0, 0, 500);
    expect(recognizeStroke(circle.slice(0, 41)).shape).toBeNull();
  });
});

describe('simplifyRdp', () => {
  it('keeps corners and drops collinear points', () => {
    const points = [v2(0, 0), v2(1, 0.01), v2(2, 0), v2(2, 1), v2(2, 2)];
    expect(simplifyRdp(points, 0.1)).toEqual([v2(0, 0), v2(2, 0), v2(2, 2)]);
  });
});
