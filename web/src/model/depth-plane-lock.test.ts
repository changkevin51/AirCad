import { describe, expect, it } from 'vitest';
import { chooseStrokePlane, DepthStrokeBuffer, rebuildPlanarSession, spatialToSnapResult } from './depth-plane-lock';
import { WorkPlane } from './plane';
import type { SpatialSnapResult } from './spatial-snap';
import { v3 } from './vec';

function snap(world: { x: number; y: number; z: number }, type: SpatialSnapResult['type'] = 'free'): SpatialSnapResult {
  return { type, world, raw: world, screen: { x: 0, y: 0 } };
}

describe('chooseStrokePlane', () => {
  it('never picks XY for a vertical stroke', () => {
    const standing = chooseStrokePlane([v3(0, 0, 0), v3(0, 0, 400)], v3(0, 0, 0), { preferKind: 'XY' });
    expect(standing.kind).not.toBe('XY');
    const wall = chooseStrokePlane([v3(0, 0, 0), v3(200, 4, 200)], v3(0, 0, 0), { preferKind: 'XY' });
    expect(wall.kind).toBe('XZ');
    expect(wall.ambiguous).toBe(false);
  });

  it('picks XY unambiguously for a 45° floor stroke', () => {
    const choice = chooseStrokePlane([v3(0, 0, 0), v3(200, 200, 4)], v3(0, 0, 0), { preferKind: 'XZ' });
    expect(choice.kind).toBe('XY');
    expect(choice.ambiguous).toBe(false);
    expect(choice.candidates).toEqual(['XY']);
  });

  it('prefers the current kind for an axis-aligned leg', () => {
    const alongX = [v3(0, 0, 0), v3(400, 0, 0)];
    expect(chooseStrokePlane(alongX, v3(0, 0, 0), { preferKind: 'XY' }).kind).toBe('XY');
    expect(chooseStrokePlane(alongX, v3(0, 0, 0), { preferKind: 'XZ' }).kind).toBe('XZ');
    expect(chooseStrokePlane(alongX, v3(0, 0, 0), { preferKind: 'XY' }).ambiguous).toBe(true);
  });

  it('keeps the last-used offset when the kind does not change', () => {
    const floor = new WorkPlane('XY');
    const choice = chooseStrokePlane([v3(0, 0, 80), v3(400, 0, 40), v3(800, 300, 90)], v3(0, 0, 80), {
      preferPlane: floor,
    });
    expect(choice.kind).toBe('XY');
    expect(choice.plane.offset).toBe(0);
  });

  it('uses view alignment when the current kind is not a candidate', () => {
    const vertical = [v3(0, 0, 0), v3(0, 0, 400)];
    const fromFront = chooseStrokePlane(vertical, v3(0, 0, 0), { preferKind: 'XY', viewDir: v3(0, -1, 0) });
    expect(fromFront.kind).toBe('XZ');
    const fromRight = chooseStrokePlane(vertical, v3(0, 0, 0), { preferKind: 'XY', viewDir: v3(-1, 0, 0) });
    expect(fromRight.kind).toBe('YZ');
  });

  it('restricts candidates to planes that contain a locked axis', () => {
    const alongX = [v3(0, 0, 0), v3(400, 0, 0)];
    const lockedZ = chooseStrokePlane(alongX, v3(0, 0, 0), { preferKind: 'XY', axisLock: 'z' });
    expect(lockedZ.kind).toBe('XZ');
    expect(lockedZ.candidates).toEqual(['XZ']);
    const lockedX = chooseStrokePlane(alongX, v3(0, 0, 0), { preferKind: 'XY', axisLock: 'x' });
    expect(lockedX.kind).toBe('XY');
    expect(lockedX.candidates).toEqual(['XY', 'XZ']);
  });
});

describe('DepthStrokeBuffer', () => {
  it('dedupes nearby samples and reports world extent', () => {
    const buffer = new DepthStrokeBuffer(snap(v3(0, 0, 0)), new WorkPlane('XY'));
    buffer.append(v3(1, 0, 0), 1);
    buffer.append(v3(40, 0, 0), 1);
    expect(buffer.points.length).toBe(2);
    expect(buffer.worldExtent(v3(40, 0, 10))).toBeCloseTo(Math.hypot(40, 10), 6);
  });
});

describe('rebuildPlanarSession', () => {
  it('re-projects middle points and keeps start/last snaps', () => {
    const start = snap(v3(0, 0, 0), 'vertex');
    const last = snap(v3(0, 8, 400));
    const points = [v3(0, 0, 0), v3(10, 6, 200), v3(0, 8, 400)];
    const plane = chooseStrokePlane(points, start.world).plane;
    expect(plane.kind).toBe('XZ');
    const session = rebuildPlanarSession(plane, start, points, last);
    expect(session.start.type).toBe('vertex');
    expect(session.start.world).toEqual(v3(0, 0, 0));
    expect(session.last.world.y).toBeCloseTo(0, 6);
    expect(session.last.world.z).toBeCloseTo(400, 6);
    const path = session.worldPath();
    expect(path.length).toBeGreaterThanOrEqual(3);
    expect(path[1].y).toBeCloseTo(0, 6);
  });

  it('projects a free start onto the chosen plane', () => {
    const start = snap(v3(12, 40, 0));
    const last = snap(v3(400, 48, 8));
    const plane = chooseStrokePlane([start.world, last.world], start.world).plane;
    const converted = spatialToSnapResult(start, plane);
    expect(converted.onPlane).toBe(true);
    expect(converted.world).toEqual(plane.project(start.raw));
  });
});
