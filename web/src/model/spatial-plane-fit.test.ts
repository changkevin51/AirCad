import { describe, expect, it } from 'vitest';
import { alignLineToWorldAxis, applyInPlaneAngle, constrainSpatialLine, fitStrokePlane } from './spatial-plane-fit';
import { distance } from './vec';
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

  it('exposes two candidates for an axis-aligned stroke', () => {
    const fit = fitStrokePlane([v3(0, 0, 0), v3(200, 0, 0)], v3(0, 0, 0));
    expect(fit.ambiguous).toBe(true);
    expect(fit.candidates).toEqual(['XY', 'XZ']);
  });

  it('is unambiguous for a 45° floor stroke', () => {
    const fit = fitStrokePlane([v3(0, 0, 0), v3(200, 200, 4)], v3(0, 0, 0));
    expect(fit.kind).toBe('XY');
    expect(fit.ambiguous).toBe(false);
    expect(fit.candidates).toEqual(['XY']);
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

describe('constrainSpatialLine', () => {
  it('flattens a 15° tilt onto XY and keeps length', () => {
    const a = v3(0, 0, 0);
    const tilt = 15 * (Math.PI / 180);
    const planar = Math.cos(tilt) * 100;
    const b = v3(planar * 0.8, planar * 0.6, Math.sin(tilt) * 100);
    const constrained = constrainSpatialLine(a, b);
    expect(constrained.plane).toBe('XY');
    expect(constrained.b.z).toBeCloseTo(0, 6);
    expect(distance(constrained.a, constrained.b)).toBeCloseTo(100, 6);
  });

  it('snaps a 25° in-plane angle to the U axis', () => {
    const angle = 25 * (Math.PI / 180);
    const constrained = constrainSpatialLine(v3(0, 0, 0), v3(Math.cos(angle) * 200, Math.sin(angle) * 200, 8));
    expect(constrained.plane).toBe('XY');
    expect(constrained.axis).toBe('x');
    expect(constrained.ambiguous).toBe(false);
    expect(constrained.b.y).toBeCloseTo(0, 6);
    expect(constrained.b.z).toBeCloseTo(0, 6);
  });

  it('snaps a 70° in-plane angle to the V axis', () => {
    const angle = 70 * (Math.PI / 180);
    const constrained = constrainSpatialLine(v3(0, 0, 0), v3(Math.cos(angle) * 200, Math.sin(angle) * 200, 0));
    expect(constrained.plane).toBe('XY');
    expect(constrained.axis).toBe('y');
    expect(constrained.b.x).toBeCloseTo(0, 6);
    expect(constrained.b.z).toBeCloseTo(0, 6);
  });

  it('flags a 45° in-plane line as ambiguous', () => {
    const constrained = constrainSpatialLine(v3(0, 0, 0), v3(100, 100, 6));
    expect(constrained.plane).toBe('XY');
    expect(constrained.axis).toBeNull();
    expect(constrained.ambiguous).toBe(true);
    expect(constrained.angleDeg).toBeCloseTo(45, 4);
    expect(constrained.b.z).toBeCloseTo(0, 6);
  });

  it('leaves a body diagonal as a true 3D line', () => {
    const b = v3(100, 100, 100);
    const constrained = constrainSpatialLine(v3(0, 0, 0), b);
    expect(constrained.plane).toBeNull();
    expect(constrained.ambiguous).toBe(false);
    expect(constrained.b).toEqual(b);
  });
});

describe('applyInPlaneAngle', () => {
  it('rebuilds the endpoint in the drawn quadrant at the typed angle', () => {
    const a = v3(10, 20, 0);
    const b = v3(110, 120, 4);
    const next = applyInPlaneAngle(a, b, 'XY', 30);
    const delta = { x: next.x - a.x, y: next.y - a.y, z: next.z - a.z };
    expect(distance(a, next)).toBeCloseTo(distance(a, b), 6);
    expect(Math.abs((Math.atan2(delta.y, delta.x) * 180) / Math.PI)).toBeCloseTo(30, 5);
    expect(delta.x).toBeGreaterThan(0);
    expect(delta.y).toBeGreaterThan(0);
    expect(delta.z).toBeCloseTo(0, 6);
  });
});
