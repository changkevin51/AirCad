import { describe, expect, it } from 'vitest';
import { v3 } from '../model/vec';
import {
  CALIBRATION_MIN_SAMPLES,
  CALIBRATION_WINDOW_MS,
  CalibrationCapture,
  cameraMmToWorld,
  SpatialCursorSource,
  SpatialMapping,
} from './spatial-cursor';
import { ClockSync, type SpatialMessage } from './tracker-client';

function tracked(cameraMm: [number, number, number], overrides: Partial<SpatialMessage> = {}): SpatialMessage {
  return {
    type: 'spatial',
    v: 2,
    streamId: 's1',
    sourceRunId: 'r1',
    seq: 1,
    t: 1000,
    sampleTimeMs: 990,
    ageMs: 10,
    target: 'keycap',
    trackingEpoch: 0,
    frame: { w: 1280, h: 720, mirrored: true },
    pixel: [640, 360],
    cameraMm,
    state: 'tracked',
    fresh: true,
    reason: null,
    quality: { validPixels: 20, roiCount: 2, spreadMm: 4, pairSkewMs: 2 },
    ...overrides,
  };
}

describe('spatial mapping signs', () => {
  it('maps user-right to +X, away to +Y, physical up to +Z', () => {
    const origin = v3(0, 0, 500);
    const worldOrigin = v3(0, 0, 0);
    expect(cameraMmToWorld(v3(10, 0, 500), origin, worldOrigin, 1)).toEqual(v3(-10, 0, 0));
    expect(cameraMmToWorld(v3(-10, 0, 500), origin, worldOrigin, 1)).toEqual(v3(10, 0, 0));
    expect(cameraMmToWorld(v3(0, 0, 600), origin, worldOrigin, 1)).toEqual(v3(0, 100, 0));
    expect(cameraMmToWorld(v3(0, 20, 500), origin, worldOrigin, 1)).toEqual(v3(0, 0, 20));
    expect(cameraMmToWorld(v3(2, 4, 510), origin, worldOrigin, 5)).toEqual(v3(-10, 50, 20));
  });

  it('keeps millimetres through scale presets and does not depend on a view', () => {
    const mapping = new SpatialMapping();
    mapping.setOrigin(v3(0, 0, 500));
    mapping.setScale(10, v3(0, 0, 500));
    expect(mapping.toWorld(v3(0, 0, 510))).toEqual(v3(0, 100, 0));
    const before = mapping.toWorld(v3(3, 4, 520));
    mapping.revision += 0;
    expect(mapping.toWorld(v3(3, 4, 520))).toEqual(before);
  });
});

describe('calibration and mapping continuity', () => {
  it('accepts a stable origin capture and rejects timeout or spread', () => {
    const capture = new CalibrationCapture();
    capture.start(0);
    for (let i = 0; i < CALIBRATION_MIN_SAMPLES; i++) {
      capture.add(v3(1 + i * 0.2, 2, 500), 50 * i, true);
    }
    expect(capture.phase).toBe('collecting');
    capture.add(v3(1, 2, 500), CALIBRATION_WINDOW_MS + 10, true);
    expect(capture.phase).toBe('done');
    expect(capture.median()?.z).toBeCloseTo(500);

    const noisy = new CalibrationCapture();
    noisy.start(0);
    for (let i = 0; i < 12; i++) noisy.add(v3(i * 20, 0, 500), 40 * i, true);
    expect(noisy.phase).toBe('collecting');

    const late = new CalibrationCapture();
    late.start(0);
    expect(late.add(v3(0, 0, 500), 6000, true)).toBe('timeout');
  });

  it('uses a later stable window so the click-instant pose does not block origin', () => {
    const capture = new CalibrationCapture();
    capture.start(0);
    for (let i = 0; i < 6; i++) capture.add(v3(i * 15, 0, 500), 30 * i, true);
    for (let i = 0; i < CALIBRATION_MIN_SAMPLES; i++) {
      capture.add(v3(1, 2, 500 + i * 0.1), 250 + 30 * i, true);
    }
    expect(capture.phase).toBe('done');
    expect(capture.median()?.x).toBeCloseTo(1);
  });

  it('collects an origin without client clock sync when the wire sample is tracked', () => {
    const clock = new ClockSync(() => 400);
    const source = new SpatialCursorSource(clock, () => 400);
    source.calibration.start(0);
    for (let i = 0; i < CALIBRATION_MIN_SAMPLES + 2; i++) {
      source.apply(tracked([2, 3, 500], { seq: i + 1, t: 200 + i * 40, sampleTimeMs: 190 + i * 40 }), 200 + i * 40);
    }
    expect(source.isFresh(400)).toBe(false);
    expect(source.calibration.phase).toBe('done');
  });

  it('recenters onto an existing endpoint and reanchors scale without jumping', () => {
    const mapping = new SpatialMapping();
    mapping.setOrigin(v3(0, 0, 500));
    expect(mapping.toWorld(v3(0, 0, 500))).toEqual(v3(0, 0, 0));
    mapping.recenter(v3(10, 0, 600), v3(100, 200, 0));
    expect(mapping.toWorld(v3(10, 0, 600))).toEqual(v3(100, 200, 0));
    mapping.setScale(5, v3(10, 0, 600));
    expect(mapping.toWorld(v3(10, 0, 600))).toEqual(v3(100, 200, 0));
    expect(mapping.toWorld(v3(10, 0, 610))).toEqual(v3(100, 250, 0));
  });

  it('invalidates calibration on a new source run but not on a same-run stream switch', () => {
    const mapping = new SpatialMapping();
    mapping.sourceRunId = 'r1';
    mapping.setOrigin(v3(0, 0, 500));
    expect(mapping.invalidateRun('r1')).toBe(false);
    expect(mapping.calibrated).toBe(true);
    expect(mapping.invalidateRun('r2')).toBe(true);
    expect(mapping.calibrated).toBe(false);
  });
});

describe('spatial cursor freshness', () => {
  it('fails closed without clock sync and accepts a synced fresh sample', () => {
    const clock = new ClockSync(() => 2000);
    const source = new SpatialCursorSource(clock, () => 2000);
    source.apply(tracked([0, 0, 500]), 2000);
    expect(source.isFresh(2000)).toBe(false);
    clock.observe(1000, 1010, 0);
    source.mapping.setOrigin(v3(0, 0, 500));
    source.apply(tracked([1, 2, 500], { sampleTimeMs: 1990, t: 2000, ageMs: 10 }), 2000);
    source.mapping.sourceRunId = 'r1';
    expect(source.world).not.toBeNull();
    expect(source.isFresh(2000)).toBe(true);
  });
});
