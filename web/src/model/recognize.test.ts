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

  it('rejects scribbles and open loops', () => {
    expect(recognizeStroke(scribbleStroke()).shape).toBeNull();
    expect(recognizeStroke(rectStroke(0, 0, 1000, 1000, { gapFraction: 0.3 })).shape).toBeNull();
  });

  it('ignores tiny strokes and degenerate input', () => {
    expect(recognizeStroke([v2(0, 0), v2(0.4, 0.2)], { minSize: 5 }).reason).toBe('too small');
    expect(recognizeStroke([v2(3, 3)]).reason).toBe('too few points');
    expect(recognizeStroke([]).shape).toBeNull();
  });
});

describe('recognizeStroke: closed outlines', () => {
  const polyStroke = (corners: Vec2[], pointsPerSide = 20, jitter = 0, seed = 5): Vec2[] => {
    const rand = seededRandom(seed);
    const points: Vec2[] = [];
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % corners.length];
      for (let j = 0; j < pointsPerSide; j++) {
        const t = j / pointsPerSide;
        points.push(v2(a.x + (b.x - a.x) * t + (rand() - 0.5) * jitter, a.y + (b.y - a.y) * t + (rand() - 0.5) * jitter));
      }
    }
    points.push(v2(points[0].x + (rand() - 0.5) * jitter, points[0].y + (rand() - 0.5) * jitter));
    return points;
  };

  it('recognises triangles, trapezoids, pentagons and concave outlines as polygons with vertices preserved', () => {
    const cases: Vec2[][] = [
      [v2(0, 0), v2(400, 0), v2(100, 300)],
      [v2(0, 0), v2(400, 0), v2(300, 200), v2(100, 200)],
      [v2(0, 0), v2(300, 0), v2(400, 200), v2(200, 350), v2(-50, 200)],
      [v2(0, 0), v2(400, 0), v2(400, 100), v2(100, 100), v2(100, 300), v2(0, 300)],
    ];
    for (const corners of cases) {
      for (const jitter of [0, 4]) {
        const result = recognizeStroke(polyStroke(corners, 20, jitter));
        expect(result.shape?.kind).toBe('polygon');
        if (result.shape?.kind !== 'polygon') continue;
        if (jitter === 0) expect(result.shape.corners.length).toBe(corners.length);
        else expect(result.shape.corners.length).toBeGreaterThanOrEqual(corners.length);
        for (const corner of corners) {
          expect(result.shape.corners.some((c) => Math.hypot(c.x - corner.x, c.y - corner.y) <= 2 * Math.max(1, jitter))).toBe(true);
        }
      }
    }
  });

  it('keeps a closed round stroke a many-sided sampled polygon, never a circle or rectangle', () => {
    for (const count of [80, 160]) {
      const result = recognizeStroke(circleStroke(200, -300, 500, count));
      expect(result.shape?.kind).toBe('polygon');
      if (result.shape?.kind !== 'polygon') continue;
      expect(result.shape.corners.length).toBeGreaterThan(8);
      const cx = result.shape.corners.reduce((s, c) => s + c.x, 0) / result.shape.corners.length;
      const cy = result.shape.corners.reduce((s, c) => s + c.y, 0) / result.shape.corners.length;
      expect(Math.hypot(cx - 200, cy + 300)).toBeLessThan(20);
      for (const corner of result.shape.corners) {
        expect(Math.hypot(corner.x - 200, corner.y + 300)).toBeCloseTo(500, 0);
      }
    }
  });

  it('preserves the uneven radii of a wobbly round outline instead of fitting a circle', () => {
    const points = Array.from({ length: 121 }, (_, i) => {
      const angle = (i * Math.PI * 2) / 120;
      const radius = 500 * (1 + 0.05 * Math.sin(angle * 3) + 0.025 * Math.cos(angle * 7));
      return v2(200 + Math.cos(angle) * radius * 1.04, -300 + Math.sin(angle) * radius * 0.97);
    });
    const result = recognizeStroke(points);
    expect(result.shape?.kind).toBe('polygon');
    if (result.shape?.kind !== 'polygon') return;
    expect(result.shape.corners.length).toBeGreaterThan(8);
    const radii = result.shape.corners.map((c) => Math.hypot(c.x - 200, c.y + 300));
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(10);
  });

  it.each([240, 270, 300])('leaves a %s degree arc unrecognized in either direction', (sweep) => {
    for (const direction of [1, -1]) {
      for (const phase of [0, 0.7]) {
        const points = Array.from({ length: 101 }, (_, i) => {
          const angle = phase + direction * sweep * Math.PI / 180 * i / 100;
          return v2(200 + 500 * Math.cos(angle), -300 + 500 * Math.sin(angle));
        });
        const result = recognizeStroke(points);
        expect(result.shape).toBeNull();
      }
    }
  });

  it('rejects open outlines, bowties, scribbles and retraced loops', () => {
    const bowtie = [v2(0, 0), v2(400, 300), v2(0, 300), v2(400, 0)];
    expect(recognizeStroke(polyStroke(bowtie)).shape).toBeNull();
    expect(recognizeStroke(scribbleStroke()).shape).toBeNull();
    const circle = circleStroke(0, 0, 500);
    expect(recognizeStroke([...circle, ...circle.slice(1)]).shape).toBeNull();
    expect(recognizeStroke(rectStroke(0, 0, 1000, 1000, { gapFraction: 0.3 })).shape).toBeNull();
    expect(recognizeStroke([v2(0, 0), v2(500, 0), v2(0, 0)]).shape).toBeNull();
  });

  it('simplifies dense collinear samples down to the real corners', () => {
    const triangle = polyStroke([v2(0, 0), v2(400, 0), v2(100, 300)], 120, 0);
    const result = recognizeStroke(triangle);
    expect(result.shape?.kind).toBe('polygon');
    if (result.shape?.kind !== 'polygon') return;
    expect(result.shape.corners.length).toBe(3);
  });

  it('does not box arbitrary quadrilaterals into rectangles', () => {
    const result = recognizeStroke(polyStroke([v2(0, 0), v2(400, 30), v2(350, 300), v2(80, 250)], 25, 0));
    expect(result.shape?.kind).toBe('polygon');
    if (result.shape?.kind !== 'polygon') return;
    expect(result.shape.corners.length).toBe(4);
  });

  it('still recognises genuine rectangles over the polygon fallback', () => {
    expect(recognizeStroke(rectStroke(0, 0, 1000, 1000)).shape?.kind).toBe('rect');
    expect(recognizeStroke(rotatePoints(rectStroke(0, 0, 1000, 1000), Math.PI / 4, v2(500, 500))).shape?.kind).toBe('rect');
    expect(recognizeStroke(rectStroke(0, 0, 1000, 1000, { jitter: 30 })).shape?.kind).toBe('rect');
  });
});

describe('simplifyRdp', () => {
  it('keeps corners and drops collinear points', () => {
    const points = [v2(0, 0), v2(1, 0.01), v2(2, 0), v2(2, 1), v2(2, 2)];
    expect(simplifyRdp(points, 0.1)).toEqual([v2(0, 0), v2(2, 0), v2(2, 2)]);
  });
});
