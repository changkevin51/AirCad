import { describe, expect, it } from 'vitest';
import { nextPlaneKind, WorkPlane } from './plane';
import { v2, v3 } from './vec';

describe('WorkPlane', () => {
  it('round-trips plane and world coordinates on every plane kind', () => {
    for (const kind of ['XY', 'XZ', 'YZ'] as const) {
      const plane = new WorkPlane(kind, v3(120, -45, 300));
      const q = v2(1234.5, -678.9);
      const world = plane.toWorld(q);
      expect(plane.contains(world)).toBe(true);
      const back = plane.toPlane(world);
      expect(back.x).toBeCloseTo(q.x, 9);
      expect(back.y).toBeCloseTo(q.y, 9);
    }
  });

  it('uses absolute world coordinates along the plane axes', () => {
    const plane = new WorkPlane('XZ', v3(0, 2500, 0));
    const world = plane.toWorld(v2(4000, 3000));
    expect(world).toEqual(v3(4000, 2500, 3000));
    expect(plane.toPlane(v3(10, 99, 20))).toEqual(v2(10, 20));
  });

  it('passes through the anchor and reports signed distance', () => {
    const plane = new WorkPlane('YZ', v3(1500, 0, 0));
    expect(plane.signedDistance(v3(1500, 5, 5))).toBeCloseTo(0);
    expect(plane.signedDistance(v3(1600, 5, 5))).toBeCloseTo(100);
    expect(plane.project(v3(1600, 5, 5))).toEqual(v3(1500, 5, 5));
  });

  it('intersects rays and rejects edge-on or behind cases', () => {
    const plane = new WorkPlane('XY', v3(0, 0, 100));
    expect(plane.intersectRay(v3(10, 20, 1000), v3(0, 0, -1))).toEqual(v3(10, 20, 100));
    expect(plane.intersectRay(v3(10, 20, 1000), v3(1, 0, 0))).toBeNull();
    expect(plane.intersectRay(v3(10, 20, 0), v3(0, 0, -1))).toBeNull();
    expect(plane.intersectRay(v3(10, 20, 0), v3(0, 0, -1), true)).toEqual(v3(10, 20, 100));
  });

  it('detects edge-on views', () => {
    const plane = new WorkPlane('XZ');
    expect(plane.isEdgeOn(v3(0, 0, -1))).toBe(true);
    expect(plane.isEdgeOn(v3(0, 1, 0))).toBe(false);
  });

  it('cycles plane kinds and keeps the anchor', () => {
    const plane = new WorkPlane('XY', v3(1, 2, 3));
    const next = plane.withKind(nextPlaneKind(plane.kind));
    expect(next.kind).toBe('XZ');
    expect(next.anchor).toEqual(v3(1, 2, 3));
    expect(nextPlaneKind('YZ')).toBe('XY');
  });
});
