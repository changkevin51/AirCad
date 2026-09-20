import { describe, expect, it } from 'vitest';
import { recognizeStroke, simplifyRdp, type RecognizedRect } from './recognize';
import { circleStroke, lineStroke, rectStroke, rotatePoints, scribbleStroke, seededRandom, triangleStroke } from './test-helpers';
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
  it('keeps jittered, bowed, softened and rotated rectangles out of circle correction', () => {
    const strokes = [
      rectStroke(0, 0, 1000, 1000, { pointsPerSide: 12, jitter: 80 }),
      rectStroke(0, 0, 1000, 1000, { pointsPerSide: 8, jitter: 120, overshoot: 0.04 }),
      rotatePoints(rectStroke(0, 0, 1000, 1000, { pointsPerSide: 12, jitter: 80 }), 0.35, v2(500, 500)),
      rectStroke(0, 0, 1400, 800, { pointsPerSide: 12, jitter: 90, gapFraction: 0.005 }),
      roughBowedRectStroke(0, 0, 1000, 700),
    ];
    for (const stroke of strokes) expect(recognizeStroke(stroke).shape?.kind).toBe('rect');
  });

  it('does not correct an open three-sided angular stroke into a circle', () => {
    const stroke = rectStroke(0, 0, 1000, 1000, { pointsPerSide: 12, jitter: 70, gapFraction: 0.2 });
    expect(recognizeStroke(stroke).shape?.kind).not.toBe('circle');
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

describe('recognizeStroke: triangles', () => {
  const windingOf = (corners: readonly Vec2[]): number =>
    Math.sign((corners[1].x - corners[0].x) * (corners[2].y - corners[0].y) - (corners[1].y - corners[0].y) * (corners[2].x - corners[0].x));

  const expectTriangle = (points: Vec2[], winding: number): [Vec2, Vec2, Vec2] => {
    const result = recognizeStroke(points);
    expect(result.reason).toBe('triangle');
    expect(result.shape?.kind).toBe('triangle');
    if (result.shape?.kind !== 'triangle') throw new Error(`expected a triangle, got ${result.reason}`);
    expect(result.shape.corners).toHaveLength(3);
    for (const corner of result.shape.corners) {
      expect(Number.isFinite(corner.x)).toBe(true);
      expect(Number.isFinite(corner.y)).toBe(true);
    }
    expect(windingOf(result.shape.corners)).toBe(winding);
    const start = points[0];
    const distances = result.shape.corners.map((corner) => Math.hypot(corner.x - start.x, corner.y - start.y));
    expect(distances[0]).toBe(Math.min(...distances));
    return result.shape.corners;
  };

  it('recognises a clean triangle', () => {
    const result = recognizeStroke([v2(0, 0), v2(1000, 0), v2(350, 800), v2(0, 0)]);
    expect(result.reason).toBe('triangle');
    expect(result.shape?.kind).toBe('triangle');
    if (result.shape?.kind !== 'triangle') return;
    expect(result.shape.corners).toHaveLength(3);
    const expected = [v2(0, 0), v2(1000, 0), v2(350, 800)];
    for (const [index, corner] of result.shape.corners.entries()) {
      expect(corner.x).toBeCloseTo(expected[index].x, 6);
      expect(corner.y).toBeCloseTo(expected[index].y, 6);
    }
  });

  it.each([
    [[v2(0, 0), v2(1000, 0), v2(500, 866)]],
    [[v2(0, 0), v2(1000, 0), v2(0, 800)]],
    [[v2(0, 0), v2(1000, 0), v2(350, 800)]],
  ] as const)('recognises a dense triangle %j in either winding', (corners) => {
    for (const clockwise of [false, true]) {
      const corners3 = triangleStroke([...corners], { clockwise });
      expectTriangle(corners3, clockwise ? -1 : 1);
    }
  });

  it('keeps arbitrary orientation and follows the pen from an edge start', () => {
    const corners: [Vec2, Vec2, Vec2] = [v2(0, 0), v2(1000, 0), v2(350, 800)];
    for (const startFraction of [0.17, 0.55]) {
      const points = rotatePoints(triangleStroke(corners, { startFraction }), 0.6, v2(500, 400));
      const fitted = expectTriangle(points, 1);
      const rotated = rotatePoints(corners, 0.6, v2(500, 400));
      for (const corner of fitted) {
        expect(rotated.some((candidate) => Math.hypot(candidate.x - corner.x, candidate.y - corner.y) < 80)).toBe(true);
      }
    }
  });

  it('accepts a small closing gap', () => {
    const points = triangleStroke([v2(0, 0), v2(1000, 0), v2(350, 800)], { gapFraction: 0.02 });
    expectTriangle(points, 1);
  });

  it('autocorrects deterministic jitter 40 on a 1000mm triangle', () => {
    const points = triangleStroke([v2(0, 0), v2(1000, 0), v2(350, 800)], { jitter: 40 });
    expectTriangle(points, 1);
  });

  it('autocorrects deterministic jitter 70 on a 1000mm triangle', () => {
    const points = triangleStroke([v2(0, 0), v2(1000, 0), v2(350, 800)], { jitter: 70 });
    expectTriangle(points, 1);
  });

  it('classifies triangles at tiny scale and far-off coordinates', () => {
    expectTriangle(triangleStroke([v2(0, 0), v2(0.01, 0), v2(0.0035, 0.008)]), 1);
    expectTriangle(triangleStroke([v2(1e9, -1e9), v2(1e9 + 1000, -1e9), v2(1e9 + 350, -1e9 + 800)]), 1);
  });

  it('does not recognise open, collinear, retraced, or scribbled strokes as triangles', () => {
    const corners: [Vec2, Vec2, Vec2] = [v2(0, 0), v2(1000, 0), v2(350, 800)];
    expect(recognizeStroke(triangleStroke(corners, { gapFraction: 0.3 })).shape?.kind).not.toBe('triangle');
    expect(recognizeStroke([v2(0, 0), v2(500, 0), v2(1000, 0), v2(0, 0)]).shape?.kind).not.toBe('triangle');
    const closed = triangleStroke(corners);
    expect(recognizeStroke([...closed, ...closed.slice(1)]).shape?.kind).not.toBe('triangle');
    expect(recognizeStroke(scribbleStroke()).shape?.kind).not.toBe('triangle');
  });
});

describe('recognizeStroke: circles', () => {
  it.each([[0, 0, 1000], [125, -400, 25], [1e9, -1e9, 500], [0, 0, 0.01]])('fits a circle at %s, %s with radius %s', (cx, cy, radius) => {
    const result = recognizeStroke(circleStroke(cx, cy, radius));
    expect(result.reason).toBe('circle');
    expect(result.shape?.kind).toBe('circle');
    if (result.shape?.kind !== 'circle') return;
    expect(result.shape.center.x).toBeCloseTo(cx, 5);
    expect(result.shape.center.y).toBeCloseTo(cy, 5);
    expect(result.shape.radius).toBeCloseTo(radius, 5);
  });

  it('accepts either direction, arbitrary starts and a small closing gap', () => {
    const ring = circleStroke(200, -300, 600).slice(0, -1);
    const shifted = [...ring.slice(19), ...ring.slice(0, 19)];
    for (const points of [[...shifted, shifted[0]], [...shifted, shifted[0]].reverse(), shifted.slice(0, -2)]) {
      const result = recognizeStroke(points);
      expect(result.shape?.kind).toBe('circle');
      if (result.shape?.kind === 'circle') expect(result.shape.radius).toBeCloseTo(600, 4);
    }
  });

  it('autocorrects a wobbly slightly oval loop', () => {
    const points = Array.from({ length: 121 }, (_, i) => {
      const angle = (i * Math.PI * 2) / 120;
      const radius = 500 * (1 + 0.05 * Math.sin(angle * 3) + 0.025 * Math.cos(angle * 7));
      return v2(200 + Math.cos(angle) * radius * 1.04, -300 + Math.sin(angle) * radius * 0.97);
    });
    const result = recognizeStroke(points);
    expect(result.shape?.kind).toBe('circle');
    if (result.shape?.kind !== 'circle') return;
    expect(Math.hypot(result.shape.center.x - 200, result.shape.center.y + 300)).toBeLessThan(25);
    expect(Math.abs(result.shape.radius - 500)).toBeLessThan(30);
  });

  it('handles unequal drawing speed and repeated samples', () => {
    const points = Array.from({ length: 161 }, (_, i) => {
      const t = (i / 160) ** 3 * Math.PI * 2;
      return v2(120 + 500 * Math.cos(t), 80 + 500 * Math.sin(t));
    });
    const result = recognizeStroke(points.flatMap((point, i) => (i < 100 ? [point, point, point] : [point])));
    expect(result.shape?.kind).toBe('circle');
    if (result.shape?.kind === 'circle') {
      expect(result.shape.center.x).toBeCloseTo(120, 4);
      expect(result.shape.center.y).toBeCloseTo(80, 4);
      expect(result.shape.radius).toBeCloseTo(500, 4);
    }
  });

  it.each([40, 100, 240])('autocorrects seeded jitter with %s samples', (count) => {
    const rand = seededRandom(17);
    const points = circleStroke(200, -300, 500, count).map((p) => v2(p.x + (rand() - 0.5) * 60, p.y + (rand() - 0.5) * 60));
    const result = recognizeStroke(points);
    expect(result.shape?.kind).toBe('circle');
    if (result.shape?.kind !== 'circle') return;
    expect(Math.hypot(result.shape.center.x - 200, result.shape.center.y + 300)).toBeLessThan(30);
    expect(Math.abs(result.shape.radius - 500)).toBeLessThan(30);
  });

  it.each([240, 270, 300])('closes a circular arc covering %s degrees in either direction', (sweep) => {
    for (const direction of [1, -1]) {
      for (const phase of [0, 0.7]) {
        const points = Array.from({ length: 101 }, (_, i) => {
          const angle = phase + direction * sweep * Math.PI / 180 * i / 100;
          return v2(200 + 500 * Math.cos(angle), -300 + 500 * Math.sin(angle));
        });
        const result = recognizeStroke(points);
        expect(result.shape?.kind).toBe('circle');
        if (result.shape?.kind !== 'circle') continue;
        expect(result.shape.center.x).toBeCloseTo(200, 5);
        expect(result.shape.center.y).toBeCloseTo(-300, 5);
        expect(result.shape.radius).toBeCloseTo(500, 5);
      }
    }
  });

  it.each([[0.20, 5], [0.24, 4]])('autocorrects circular squiggles with wobble %s and frequency %s', (amplitude, frequency) => {
    const points = Array.from({ length: 161 }, (_, i) => {
      const angle = i * Math.PI * 2 / 160;
      const radius = 500 * (1 + amplitude * Math.sin(frequency * angle) + 0.06 * Math.cos(9 * angle));
      return v2(200 + radius * Math.cos(angle), -300 + radius * Math.sin(angle));
    });
    const result = recognizeStroke(points);
    expect(result.shape?.kind).toBe('circle');
    if (result.shape?.kind !== 'circle') return;
    expect(Math.hypot(result.shape.center.x - 200, result.shape.center.y + 300)).toBeLessThan(100);
    expect(Math.abs(result.shape.radius - 500)).toBeLessThan(100);
  });

  it.each([40, 100, 240])('accepts stronger hand jitter with %s samples', (count) => {
    const rand = seededRandom(17);
    const points = circleStroke(200, -300, 500, count).map((point) => v2(point.x + (rand() - 0.5) * 160, point.y + (rand() - 0.5) * 160));
    const result = recognizeStroke(points);
    expect(result.shape?.kind).toBe('circle');
    if (result.shape?.kind !== 'circle') return;
    expect(Math.hypot(result.shape.center.x - 200, result.shape.center.y + 300)).toBeLessThan(100);
    expect(Math.abs(result.shape.radius - 500)).toBeLessThan(100);
  });

  it('accepts an incomplete wavy circle', () => {
    const points = Array.from({ length: 161 }, (_, i) => {
      const angle = 0.7 + 240 * Math.PI / 180 * i / 160;
      const radius = 500 * (1 + 0.16 * Math.sin(4 * angle) + 0.05 * Math.cos(7 * angle));
      return v2(200 + radius * Math.cos(angle), -300 + radius * Math.sin(angle));
    });
    expect(recognizeStroke(points).shape?.kind).toBe('circle');
  });

  it('still requires most of a circular loop and honors the circle gap option', () => {
    const arc = (sweep: number) => Array.from({ length: 101 }, (_, i) => { const a = sweep * Math.PI / 180 * i / 100; return v2(500 * Math.cos(a), 500 * Math.sin(a)); });
    expect(recognizeStroke(arc(210)).shape?.kind).not.toBe('circle');
    expect(recognizeStroke(arc(240), { circleMaxGapDeg: 90 }).shape?.kind).not.toBe('circle');
    expect(recognizeStroke(arc(240)).shape?.kind).toBe('circle');
  });

  it('preserves squares/rectangles and rejects short arcs, elongated ellipses and retraced loops as circles', () => {
    expect(recognizeStroke(rectStroke(0, 0, 1000, 1000)).shape?.kind).toBe('rect');
    expect(recognizeStroke(rotatePoints(rectStroke(0, 0, 1000, 1000), Math.PI / 4, v2(500, 500))).shape?.kind).toBe('rect');
    expect(recognizeStroke(rectStroke(0, 0, 1000, 1000, { jitter: 30 })).shape?.kind).toBe('rect');
    const circle = circleStroke(0, 0, 500);
    for (const points of [
      circle.slice(0, 41),
      circle.map((p) => v2(p.x * 1.8, p.y)),
      [...circle, ...circle.slice(1)],
      [v2(0, 0), v2(500, 0), v2(0, 0)],
      Array.from({ length: 121 }, (_, i) => { const a = (i * Math.PI * 2) / 120; return v2(500 * Math.sin(a), 500 * Math.sin(2 * a)); }),
    ]) {
      expect(recognizeStroke(points).shape?.kind).not.toBe('circle');
    }
  });
});

describe('simplifyRdp', () => {
  it('keeps corners and drops collinear points', () => {
    const points = [v2(0, 0), v2(1, 0.01), v2(2, 0), v2(2, 1), v2(2, 2)];
    expect(simplifyRdp(points, 0.1)).toEqual([v2(0, 0), v2(2, 0), v2(2, 2)]);
  });
});
