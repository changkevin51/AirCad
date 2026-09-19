import { describe, expect, it } from 'vitest';
import { WorkPlane } from './plane';
import { adaptiveGridStep, snapCursor, type SnapContext, type SnapTargets } from './snap';
import { makeRect, Sketch } from './sketch';
import { frontViewProjector, topViewProjector } from './test-helpers';
import { v2, v3 } from './vec';

function targetsOf(sketch: Sketch): SnapTargets {
  return { vertices: sketch.vertices(), midpoints: sketch.midpoints(), segments: sketch.segments() };
}

function floorSketch(): Sketch {
  const sketch = new Sketch();
  sketch.addEntity({ type: 'rect', corners: makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000) });
  return sketch;
}

// 0.1 px/mm: 10 mm per pixel, world origin at screen (400, 300).
const projector = topViewProjector(0.1, 400, 300);
const screenOf = (x: number, y: number) => projector.project(v3(x, y, 0))!;

function context(overrides: Partial<SnapContext>): SnapContext {
  return {
    cursor: v2(0, 0),
    projector,
    plane: new WorkPlane('XY'),
    targets: targetsOf(floorSketch()),
    gridStep: 100,
    gridEnabled: true,
    ...overrides,
  };
}

describe('snapCursor priorities', () => {
  it('snaps to a vertex within tolerance, beating a nearby edge', () => {
    const corner = screenOf(4000, 3000);
    const result = snapCursor(context({ cursor: v2(corner.x - 9, corner.y + 8) }));
    expect(result.type).toBe('vertex');
    expect(result.world).toEqual(v3(4000, 3000, 0));
    expect(result.onPlane).toBe(true);
    expect(result.entityId).toBe('e1');
  });

  it('prefers midpoints over edges and grid', () => {
    const mid = screenOf(2000, 0);
    const result = snapCursor(context({ cursor: v2(mid.x + 6, mid.y - 10) }));
    expect(result.type).toBe('midpoint');
    expect(result.world).toEqual(v3(2000, 0, 0));
  });

  it('snaps to an edge when no vertex or midpoint is close', () => {
    const onEdge = screenOf(1000, 0);
    const result = snapCursor(context({ cursor: v2(onEdge.x, onEdge.y - 7) }));
    expect(result.type).toBe('edge');
    expect(result.world.x).toBeCloseTo(1000);
    expect(result.world.y).toBeCloseTo(0);
  });

  it('falls back to the grid and then to free positions', () => {
    const cursor = screenOf(1234, 1567);
    const grid = snapCursor(context({ cursor }));
    expect(grid.type).toBe('grid');
    expect(grid.world).toEqual(v3(1200, 1600, 0));
    expect(grid.raw?.x).toBeCloseTo(1234);
    expect(grid.raw?.y).toBeCloseTo(1567);

    const free = snapCursor(context({ cursor, gridEnabled: false }));
    expect(free.type).toBe('free');
    expect(free.world.x).toBeCloseTo(1234);
    expect(free.world.y).toBeCloseTo(1567);
  });

  it('axis-aligns to the stroke start within 8 degrees and keeps grid on the free axis', () => {
    const start = v3(1000, 1000, 0);
    const nearlyHorizontal = snapCursor(context({ cursor: screenOf(2510, 1120), strokeStart: start }));
    expect(nearlyHorizontal.type).toBe('axis');
    expect(nearlyHorizontal.axis).toBe('u');
    expect(nearlyHorizontal.world).toEqual(v3(2500, 1000, 0));

    const nearlyVertical = snapCursor(context({ cursor: screenOf(1050, 2440), strokeStart: start }));
    expect(nearlyVertical.type).toBe('axis');
    expect(nearlyVertical.axis).toBe('v');
    expect(nearlyVertical.world).toEqual(v3(1000, 2400, 0));

    const diagonal = snapCursor(context({ cursor: screenOf(2000, 1800), strokeStart: start }));
    expect(diagonal.type).toBe('grid');
  });

  it('lets a vertex win over axis alignment', () => {
    const start = v3(0, 3020, 0);
    const corner = screenOf(4000, 3000);
    const result = snapCursor(context({ cursor: v2(corner.x - 4, corner.y), strokeStart: start }));
    expect(result.type).toBe('vertex');
  });

  it('reaches off-plane vertices through screen space', () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'line', a: v3(100, 500, 0), b: v3(100, 500, 2500) });
    const plane = new WorkPlane('XZ', v3(0, 0, 0));
    const cursor = screenOf(100, 500);
    const result = snapCursor(context({ cursor: v2(cursor.x + 3, cursor.y), plane, targets: targetsOf(sketch) }));
    expect(result.type).toBe('vertex');
    expect(result.onPlane).toBe(false);
    expect(result.world.y).toBe(500);
  });

  it('hard-locks to a world axis through the stroke start', () => {
    const front = frontViewProjector(0.1, 400, 300);
    const start = v3(1000, 0, 0);
    const cursor = front.project(v3(1300, 0, 2000))!;
    const result = snapCursor(
      context({ cursor, projector: front, plane: new WorkPlane('XZ'), strokeStart: start, axisLock: 'z', gridStep: 100 }),
    );
    expect(result.type).toBe('lock');
    expect(result.axis).toBe('z');
    expect(result.world.x).toBeCloseTo(1000);
    expect(result.world.z).toBeCloseTo(2000);
  });

  it('reports a free off-plane point when the plane is edge-on', () => {
    const result = snapCursor(context({ cursor: v2(120, 80), plane: new WorkPlane('XZ') }));
    expect(result.type).toBe('free');
    expect(result.onPlane).toBe(false);
    expect(result.raw).toBeNull();
  });

  it('can ignore object snaps and exclude an entity', () => {
    const corner = screenOf(0, 0);
    const excluded = snapCursor(context({ cursor: corner, excludeEntityId: 'e1' }));
    expect(excluded.type).toBe('grid');
    const disabled = snapCursor(context({ cursor: corner, disableObjectSnaps: true }));
    expect(disabled.type).toBe('grid');
  });
});

describe('snapCursor: circles', () => {
  const circleSketch = () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'circle', center: v3(0, 0, 0), normal: v3(0, 0, 1), radius: 1000 });
    return sketch;
  };

  it('offers only centre and quadrant vertices, no tessellation midpoints', () => {
    const targets = targetsOf(circleSketch());
    expect(targets.vertices).toHaveLength(5);
    expect(targets.midpoints).toHaveLength(0);
    expect(targets.segments).toHaveLength(96);
    const centre = snapCursor(context({ cursor: screenOf(5, -5), targets }));
    expect(centre.type).toBe('vertex');
    expect(centre.world).toEqual(v3(0, 0, 0));
    const quad = screenOf(1000, 0);
    const quadrant = snapCursor(context({ cursor: v2(quad.x - 6, quad.y + 6), targets }));
    expect(quadrant.type).toBe('vertex');
    expect(quadrant.world).toEqual(v3(1000, 0, 0));
  });

  it('snaps edges exactly onto the analytic circle, not the tessellation chord', () => {
    const targets = targetsOf(circleSketch());
    const along = 1000 / Math.sqrt(2) + 20;
    const result = snapCursor(context({ cursor: screenOf(along, along), targets }));
    expect(result.type).toBe('edge');
    expect(result.entityId).toBe('e1');
    expect(Math.hypot(result.world.x, result.world.y)).toBeCloseTo(1000, 6);
    expect(result.world.z).toBe(0);
  });
});

describe('adaptiveGridStep', () => {
  it('picks the smallest step that is at least minPx on screen', () => {
    const plane = new WorkPlane('XY');
    expect(adaptiveGridStep(topViewProjector(0.1), plane, v3(0, 0, 0), 10)).toBe(100);
    expect(adaptiveGridStep(topViewProjector(1.5), plane, v3(0, 0, 0), 10)).toBe(10);
    expect(adaptiveGridStep(topViewProjector(20), plane, v3(0, 0, 0), 10)).toBe(1);
    expect(adaptiveGridStep(topViewProjector(0.005), plane, v3(0, 0, 0), 10)).toBe(1000);
  });
});
