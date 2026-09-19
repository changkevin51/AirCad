import { describe, expect, it } from 'vitest';
import { SpatialStrokeSession, SPATIAL_RESUME_MS } from './spatial-stroke';
import type { SpatialSnapResult } from './spatial-snap';
import { v3 } from './vec';

const identity = {
  streamId: 's1',
  sourceRunId: 'r1',
  trackingEpoch: 0,
  mappingRevision: 1,
};

function snap(world: { x: number; y: number; z: number }): SpatialSnapResult {
  return { type: 'free', world, raw: world, screen: null };
}

describe('SpatialStrokeSession', () => {
  it('commits a diagonal and an axial line with preview equal to commit', () => {
    const diagonal = new SpatialStrokeSession(snap(v3(0, 0, 0)), identity, 0);
    expect(diagonal.update(snap(v3(30, 40, 50)), identity, true, 10)).toBe(true);
    expect(diagonal.canCommit(1)).toBe(true);
    expect(diagonal.preview()).toEqual({ a: v3(0, 0, 0), b: v3(30, 40, 50) });
    expect(diagonal.delta()).toEqual(v3(30, 40, 50));

    const axial = new SpatialStrokeSession(snap(v3(0, 0, 0)), identity, 0);
    axial.update(snap(v3(0, 80, 0)), identity, true, 10);
    expect(axial.canCommit(1)).toBe(true);
    expect(axial.length()).toBe(80);
  });

  it('rejects a short line and a non-finite endpoint', () => {
    const short = new SpatialStrokeSession(snap(v3(0, 0, 0)), identity, 0);
    short.update(snap(v3(2, 0, 0)), identity, true, 10);
    expect(short.canCommit(1)).toBe(false);
    const bad = new SpatialStrokeSession(snap(v3(0, 0, 0)), identity, 0);
    bad.update(snap(v3(Number.NaN, 0, 0)), identity, true, 10);
    expect(bad.canCommit(1)).toBe(false);
  });

  it('resumes a short nearby gap and cancels a long loss or identity change', () => {
    const session = new SpatialStrokeSession(snap(v3(0, 0, 0)), identity, 0);
    session.update(snap(v3(20, 0, 0)), identity, true, 10);
    session.pause(20);
    expect(session.paused).toBe(true);
    expect(session.update(snap(v3(21, 0, 0)), identity, true, 40)).toBe(false);
    expect(session.update(snap(v3(21, 0, 0)), identity, true, 50)).toBe(false);
    expect(session.update(snap(v3(21, 0, 0)), identity, true, 60)).toBe(true);
    expect(session.status).toBe('active');
    expect(session.current.world).toEqual(v3(21, 0, 0));

    const lost = new SpatialStrokeSession(snap(v3(0, 0, 0)), identity, 0);
    lost.update(snap(v3(20, 0, 0)), identity, true, 10);
    lost.pause(20);
    expect(lost.update(snap(v3(21, 0, 0)), identity, true, 20 + SPATIAL_RESUME_MS + 1)).toBe(false);
    expect(lost.status).toBe('dead');

    const switched = new SpatialStrokeSession(snap(v3(0, 0, 0)), identity, 0);
    switched.update(snap(v3(20, 0, 0)), identity, true, 10);
    expect(switched.update(snap(v3(25, 0, 0)), { ...identity, trackingEpoch: 2 }, true, 20)).toBe(false);
    expect(switched.paused).toBe(true);

    const distant = new SpatialStrokeSession(snap(v3(0, 0, 0)), identity, 0);
    distant.update(snap(v3(20, 0, 0)), identity, true, 10);
    distant.pause(20);
    expect(distant.update(snap(v3(200, 0, 0)), identity, true, 40)).toBe(false);
    expect(distant.status).toBe('dead');
  });

  it('does not commit while paused', () => {
    const session = new SpatialStrokeSession(snap(v3(0, 0, 0)), identity, 0);
    session.update(snap(v3(40, 0, 0)), identity, true, 10);
    session.pause(20);
    expect(session.canCommit(1)).toBe(false);
  });

  it('keeps a raw polyline and projects it onto the fitted plane', () => {
    const session = new SpatialStrokeSession(snap(v3(0, 0, 0)), identity, 0);
    session.update(snap(v3(40, 30, 4)), identity, true, 10);
    session.update(snap(v3(80, 70, -3)), identity, true, 20);
    session.update(snap(v3(120, 110, 5)), identity, true, 30);
    expect(session.points.length).toBeGreaterThan(2);
    expect(session.polyline().at(-1)).toEqual(v3(120, 110, 5));
    const fitted = session.fitted();
    expect(fitted.kind).toBe('XY');
    expect(fitted.session.pointCount).toBeGreaterThanOrEqual(3);
    expect(fitted.session.start.world).toEqual(v3(0, 0, 0));
  });
});
