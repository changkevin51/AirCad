import { describe, expect, it } from 'vitest';
import { alignLineToWorldAxis, fitStrokePlane } from './spatial-plane-fit';
import { v3 } from './vec';

function jittered(points: { x: number; y: number; z: number }[], amp = 30): { x: number; y: number; z: number }[] {
  return points.map((point, i) =>
    v3(point.x + ((i % 3) - 1) * (amp / 3), point.y + (((i + 1) % 3) - 1) * (amp / 3), point.z + (((i + 2) % 3) - 1) * (amp / 3)),
  );
}

describe('fitStrokePlane', () => {
  it('detects XY from a loop with 30 mm depth jitter', () => {
    const points = jittered([
      v3(0, 0, 0),
      v3(400, 0, 8),
      v3(800, 20, -12),
      v3(800, 400, 15),
      v3(400, 600, -10),
      v3(0, 600, 18),
      v3(0, 0, 5),
    ]);
    const fit = fitStrokePlane(points, v3(0, 0, 0));
    expect(fit.kind).toBe('XY');
    expect(fit.planar).toBe(true);
    expect(fit.straight).toBe(false);
  });

  it('detects XZ Front and YZ Right from extents', () => {
    const front = fitStrokePlane([v3(0, 10, 0), v3(500, 25, 0), v3(500, -8, 400), v3(0, 12, 400)], v3(0, 0, 0));
    expect(front.kind).toBe('XZ');
    expect(front.planar).toBe(true);
    const right = fitStrokePlane([v3(8, 0, 0), v3(-5, 600, 0), v3(12, 600, 400), v3(4, 0, 400)], v3(0, 0, 0));
    expect(right.kind).toBe('YZ');
    expect(right.planar).toBe(true);
  });

  it('marks a nearly straight 3D stroke as straight', () => {
    const fit = fitStrokePlane([v3(0, 0, 0), v3(120, 8, 4), v3(240, -6, 10), v3(360, 5, -3)], v3(0, 0, 0));
    expect(fit.straight).toBe(true);
  });

  it('prefers an existing floor plane when a line is ambiguous', () => {
    const line = [v3(0, 3000, 0), v3(0, 1500, -5), v3(0, 0, 0)];
    expect(fitStrokePlane(line, v3(0, 3000, 0)).kind).toBe('YZ');
    expect(fitStrokePlane(line, v3(0, 3000, 0), ['XY']).kind).toBe('XY');
  });

  it('anchors the fitted plane at the snapped start', () => {
    const fit = fitStrokePlane([v3(100, 200, 50), v3(400, 210, 55), v3(700, 190, 40)], v3(100, 200, 50));
    expect(fit.plane.anchor).toEqual(v3(100, 200, 50));
    expect(fit.kind).toBe('XY');
  });
});

describe('alignLineToWorldAxis', () => {
  it('rotates a near-X segment onto the world X axis', () => {
    const aligned = alignLineToWorldAxis(v3(0, 0, 0), v3(100, 8, 4), 12);
    expect(aligned.axis).toBe('x');
    expect(aligned.a).toEqual(v3(0, 0, 0));
    expect(aligned.b.y).toBeCloseTo(0, 6);
    expect(aligned.b.z).toBeCloseTo(0, 6);
    expect(Math.hypot(aligned.b.x, aligned.b.y, aligned.b.z)).toBeCloseTo(Math.hypot(100, 8, 4), 6);
  });

  it('leaves a clearly diagonal line alone', () => {
    const aligned = alignLineToWorldAxis(v3(0, 0, 0), v3(100, 80, 60), 12);
    expect(aligned.axis).toBeNull();
    expect(aligned.b).toEqual(v3(100, 80, 60));
  });
});
