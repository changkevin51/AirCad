import { describe, expect, it } from 'vitest';
import { recognizeStroke, simplifyRdp, type RecognizedRect } from './recognize';
import { circleStroke, lineStroke, rectStroke, rotatePoints, scribbleStroke } from './test-helpers';
import { v2 } from './vec';

function expectRectClose(rect: RecognizedRect, x0: number, y0: number, w: number, h: number, tolerance: number): void {
  const xs = rect.corners.map((c) => c.x);
  const ys = rect.corners.map((c) => c.y);
  expect(Math.min(...xs)).toBeCloseTo(x0, -Math.log10(tolerance));
  expect(Math.max(...xs)).toBeCloseTo(x0 + w, -Math.log10(tolerance));
  expect(Math.min(...ys)).toBeCloseTo(y0, -Math.log10(tolerance));
  expect(Math.max(...ys)).toBeCloseTo(y0 + h, -Math.log10(tolerance));
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

  it('rejects circles, triangles, scribbles and open loops', () => {
    expect(recognizeStroke(circleStroke(0, 0, 1000)).shape).toBeNull();
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

describe('simplifyRdp', () => {
  it('keeps corners and drops collinear points', () => {
    const points = [v2(0, 0), v2(1, 0.01), v2(2, 0), v2(2, 1), v2(2, 2)];
    expect(simplifyRdp(points, 0.1)).toEqual([v2(0, 0), v2(2, 0), v2(2, 2)]);
  });
});
