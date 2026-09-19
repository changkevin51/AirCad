import { describe, expect, it } from 'vitest';
import { closestPointOnSegment, gridStepForScale, hybridRadius, lockAxisPoint, objectRadius, snapSpatial } from './spatial-snap';
import { v3 } from './vec';

const empty = { vertices: [], midpoints: [], segments: [] };

describe('spatial snapping', () => {
  it('does not attract co-located-on-screen points that differ in depth', () => {
    const raw = v3(0, 0, 0);
    const result = snapSpatial({
      raw,
      scale: 1,
      targets: {
        vertices: [
          { point: v3(0, 0, 200), entityId: 'far', index: 0 },
          { point: v3(5, 0, 0), entityId: 'near', index: 0 },
        ],
        midpoints: [],
        segments: [],
      },
    });
    expect(result.type).toBe('vertex');
    expect(result.entityId).toBe('near');
  });

  it('clamps edge endpoints and handles a degenerate segment', () => {
    const on = closestPointOnSegment(v3(50, 0, 0), v3(0, 0, 0), v3(10, 0, 0));
    expect(on.point).toEqual(v3(10, 0, 0));
    const zero = closestPointOnSegment(v3(5, 5, 5), v3(1, 1, 1), v3(1, 1, 1));
    expect(zero.point).toEqual(v3(1, 1, 1));
  });

  it('locks a camera-parallel world axis without a ray', () => {
    const start = v3(10, 20, 30);
    const locked = lockAxisPoint(v3(10, 20, 90), start, 'z');
    expect(locked).toEqual(v3(10, 20, 90));
    const result = snapSpatial({
      raw: v3(40, 80, 90),
      start,
      axisLock: 'z',
      scale: 1,
      targets: {
        vertices: [{ point: v3(40, 80, 90), entityId: 'v', index: 0 }],
        midpoints: [],
        segments: [],
      },
    });
    expect(result.type).toBe('lock');
    expect(result.axis).toBe('z');
    expect(result.world).toEqual(v3(10, 20, 90));
  });

  it('keeps hysteresis until a same-priority challenger wins by 20%', () => {
    const targets = {
      vertices: [
        { point: v3(0, 0, 0), entityId: 'a', index: 0 },
        { point: v3(40, 0, 0), entityId: 'b', index: 0 },
      ],
      midpoints: [],
      segments: [],
    };
    const first = snapSpatial({ raw: v3(1, 0, 0), scale: 1, targets });
    expect(first.entityId).toBe('a');
    const held = snapSpatial({ raw: v3(5, 0, 0), scale: 1, targets, previous: first });
    expect(held.entityId).toBe('a');
    const won = snapSpatial({ raw: v3(36, 0, 0), scale: 1, targets, previous: first });
    expect(won.entityId).toBe('b');
  });

  it('breaks ties by entity id then index', () => {
    const result = snapSpatial({
      raw: v3(0, 0, 0),
      scale: 1,
      targets: {
        vertices: [
          { point: v3(1, 0, 0), entityId: 'b', index: 0 },
          { point: v3(1, 0, 0), entityId: 'a', index: 1 },
          { point: v3(1, 0, 0), entityId: 'a', index: 0 },
        ],
        midpoints: [],
        segments: [],
      },
    });
    expect(result.entityId).toBe('a');
    expect(result.index).toBe(0);
  });

  it('leaves the point free when the depth grid is off', () => {
    const raw = v3(13, 7, 11);
    const off = snapSpatial({ raw, scale: 1, gridEnabled: false, targets: empty });
    expect(off.type).toBe('free');
    expect(off.world).toEqual(raw);
    const on = snapSpatial({ raw, scale: 1, gridEnabled: true, targets: empty });
    expect(on.type).toBe('grid');
    expect(on.world).toEqual(v3(15, 5, 10));
    expect(gridStepForScale(2)).toBe(10);
    expect(objectRadius(2)).toBe(80);
  });

  it('does not let a distant vertex beat a nearby edge when the screen radius is huge', () => {
    const result = snapSpatial({
      raw: v3(50, 0, 0),
      scale: 1,
      worldPerPixel: 40,
      targets: {
        vertices: [{ point: v3(400, 0, 0), entityId: 'far', index: 0 }],
        midpoints: [],
        segments: [{ a: v3(0, 0, 0), b: v3(100, 0, 0), entityId: 'edge', index: 0 }],
      },
    });
    expect(result.type).toBe('edge');
    expect(result.entityId).toBe('edge');
  });

  it('uses the larger of 40 mm × scale and 22 px × worldPerPixel', () => {
    const targets = { vertices: [{ point: v3(50, 0, 0), entityId: 'v', index: 0 }], midpoints: [], segments: [] };
    const physical = snapSpatial({ raw: v3(0, 0, 0), scale: 1, targets });
    expect(physical.type).toBe('free');
    const hybrid = snapSpatial({ raw: v3(0, 0, 0), scale: 1, worldPerPixel: 3, targets });
    expect(hybrid.type).toBe('vertex');
    expect(hybridRadius(1, 3)).toBe(66);
    expect(hybridRadius(2, 0.5)).toBe(80);
  });

  it('widens the magnet radius at pen-down and prefers the last endpoint', () => {
    const magnetTargets = {
      vertices: [{ point: v3(50, 0, 0), entityId: 'far', index: 0 }],
      midpoints: [],
      segments: [],
    };
    const none = snapSpatial({ raw: v3(0, 0, 0), scale: 1, targets: magnetTargets });
    expect(none.type).toBe('free');
    const magnet = snapSpatial({ raw: v3(0, 0, 0), scale: 1, magnet: 1.5, targets: magnetTargets });
    expect(magnet.type).toBe('vertex');
    const preferred = snapSpatial({
      raw: v3(0, 0, 0),
      scale: 1,
      prefer: v3(0, 10, 0),
      targets: {
        vertices: [
          { point: v3(10, 0, 0), entityId: 'other', index: 0 },
          { point: v3(0, 10, 0), entityId: 'last', index: 0 },
        ],
        midpoints: [],
        segments: [],
      },
    });
    expect(preferred.entityId).toBe('last');
  });
});
