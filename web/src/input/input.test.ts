import { describe, expect, it } from 'vitest';
import { v2 } from '../model/vec';
import { CursorSource, mapFrameToViewport, pickCursorHand, regionRect } from './cursor';
import { holdActionForCode, keyLabel, PRESS_BINDINGS, resolveHold, resolvePress, type KeyLike } from './keymap';
import { OneEuroFilter } from './one-euro';
import {
  ClockSync,
  parseSpatialMessage,
  parseTrackerMessage,
  type HandsMessage,
  type SpatialMessage,
  type SpatialParseState,
  type TrackedHandMessage,
} from './tracker-client';

const key = (code: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe('keymap', () => {
  it('resolves press actions with platform-aware modifiers', () => {
    expect(resolvePress(key('Digit1'), 'other')).toBe('viewTop');
    expect(resolvePress(key('KeyZ', { ctrlKey: true }), 'other')).toBe('undo');
    expect(resolvePress(key('KeyZ', { ctrlKey: true, shiftKey: true }), 'other')).toBe('redo');
    expect(resolvePress(key('KeyY', { ctrlKey: true }), 'other')).toBe('redo');
    expect(resolvePress(key('KeyZ', { metaKey: true }), 'mac')).toBe('undo');
    expect(resolvePress(key('KeyZ', { ctrlKey: true }), 'mac')).toBeNull();
    expect(resolvePress(key('Backspace'), 'other')).toBe('delete');
    expect(resolvePress(key('Backspace', { ctrlKey: true }), 'other')).toBe('clear');
    expect(resolvePress(key('Backspace', { metaKey: true }), 'mac')).toBe('clear');
    expect(resolvePress(key('KeyQ'), 'other')).toBe('extrude');
    expect(resolvePress(key('KeyQ', { metaKey: true }), 'mac')).toBeNull();
    expect(resolvePress(key('KeyQ', { ctrlKey: true }), 'other')).toBeNull();
    expect(resolvePress(key('KeyS'), 'other')).toBe('select');
    expect(resolvePress(key('KeyS', { metaKey: true }), 'mac')).toBeNull();
    expect(resolvePress(key('Enter'), 'other')).toBe('confirm');
    expect(resolvePress(key('NumpadEnter'), 'other')).toBe('confirm');
    expect(resolvePress(key('KeyE'), 'other')).toBe('export');
    expect(resolvePress(key('KeyO'), 'other')).toBe('setOrigin');
    expect(resolvePress(key('KeyR'), 'other')).toBe('recenter');
  });

  it('keeps plain Z as an axis lock but not with the primary modifier', () => {
    expect(resolveHold(key('KeyZ'), 'other')).toBe('lockZ');
    expect(resolveHold(key('KeyZ', { ctrlKey: true }), 'other')).toBeNull();
    expect(resolveHold(key('Space'), 'other')).toBe('draw');
    expect(resolveHold(key('ShiftRight'), 'other')).toBe('orbit');
    expect(holdActionForCode('ControlLeft')).toBe('pan');
  });

  it('binds A to the plane mode toggle and keeps Y locking off Ctrl/Cmd+Y', () => {
    expect(resolvePress(key('KeyA'), 'other')).toBe('toggleAutoPlane');
    expect(resolveHold(key('KeyY'), 'other')).toBe('lockY');
    expect(resolveHold(key('KeyY', { ctrlKey: true }), 'other')).toBeNull();
    expect(resolvePress(key('KeyY', { ctrlKey: true }), 'other')).toBe('redo');
    expect(resolveHold(key('KeyY', { ctrlKey: true }), 'mac')).toBeNull();
    expect(resolvePress(key('KeyY', { ctrlKey: true }), 'mac')).toBe('redo');
    expect(resolveHold(key('KeyY', { metaKey: true }), 'mac')).toBeNull();
    expect(resolvePress(key('KeyY', { metaKey: true }), 'mac')).toBeNull();
  });

  it('labels primary-modifier bindings per platform', () => {
    const undo = PRESS_BINDINGS.find((b) => b.action === 'undo')!;
    expect(keyLabel(undo, 'other')).toBe('Ctrl+Z');
    expect(keyLabel(undo, 'mac')).toBe('Cmd+Z');
  });
});

describe('cursor mapping', () => {
  it('maps the central camera region onto the whole viewport', () => {
    const frame = { w: 640, h: 480 };
    const viewport = { w: 1280, h: 720 };
    const region = regionRect(frame);
    expect(region.x).toBeCloseTo(76.8);
    expect(region.y).toBeCloseTo(57.6);
    expect(region.w).toBeCloseTo(486.4);
    expect(region.h).toBeCloseTo(364.8);
    const centre = mapFrameToViewport(v2(320, 240), frame, viewport);
    expect(centre.x).toBeCloseTo(640);
    expect(centre.y).toBeCloseTo(360);
    const topLeft = mapFrameToViewport(v2(76.8, 57.6), frame, viewport);
    expect(topLeft.x).toBeCloseTo(0);
    expect(topLeft.y).toBeCloseTo(0);
    const clamped = mapFrameToViewport(v2(0, 480), frame, viewport);
    expect(clamped).toEqual(v2(0, 720));
  });

  const hand = (id: number, openArmed = false): TrackedHandMessage => ({
    id,
    handedness: 'right',
    tip: [320, 240],
    thumb: [300, 250],
    palm: [330, 300],
    palmSize: 80,
    pinching: false,
    open: openArmed,
    openArmed,
    landmarks: [],
  });

  it('sticks to the current hand and avoids the navigating palm', () => {
    expect(pickCursorHand([hand(1, true), hand(2)], null)?.id).toBe(2);
    expect(pickCursorHand([hand(1), hand(2)], 2)?.id).toBe(2);
    expect(pickCursorHand([hand(1, true)], null)?.id).toBe(1);
    expect(pickCursorHand([], 1)).toBeNull();
  });

  it('lets the mouse take over only after the hand is lost', () => {
    const cursor = new CursorSource({}, 0.3);
    const message: HandsMessage = { type: 'hands', t: 0, frame: { w: 640, h: 480 }, hands: [hand(1)], nav: null };
    cursor.updateHands(message, { w: 1000, h: 800 }, 1.0);
    expect(cursor.tracking).toBe('hand');
    expect(cursor.updateMouse(v2(5, 5), 1.1)).toBe(false);
    cursor.updateHands({ ...message, hands: [] }, { w: 1000, h: 800 }, 1.2);
    expect(cursor.tracking).toBe('lost');
    expect(cursor.position?.x).toBeCloseTo(500);
    expect(cursor.updateMouse(v2(5, 5), 1.25)).toBe(true);
    expect(cursor.tracking).toBe('mouse');
    cursor.updateHands(message, { w: 1000, h: 800 }, 1.3);
    expect(cursor.tracking).toBe('hand');
  });
});

describe('one-euro filter', () => {
  it('converges on a constant and follows a fast ramp closely', () => {
    const filter = new OneEuroFilter({ minCutoff: 1, beta: 0.05 });
    let value = 0;
    for (let i = 0; i < 60; i++) value = filter.filter(100, i / 60);
    expect(value).toBeCloseTo(100, 0);
    const fast = new OneEuroFilter({ minCutoff: 1, beta: 0.05 });
    let out = 0;
    for (let i = 0; i <= 30; i++) out = fast.filter(i * 40, i / 60);
    expect(Math.abs(out - 1200)).toBeLessThan(120);
  });
});

describe('tracker protocol parsing', () => {
  it('accepts known message types only', () => {
    expect(parseTrackerMessage('{"type":"status","camera":"ready","message":"ok"}')?.type).toBe('status');
    expect(parseTrackerMessage('{"type":"bogus"}')).toBeNull();
    expect(parseTrackerMessage('not json')).toBeNull();
  });
});

const spatial = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'spatial',
  v: 2,
  streamId: 's1',
  sourceRunId: 'r1',
  seq: 1,
  t: 1000,
  sampleTimeMs: 990,
  ageMs: 10,
  target: 'finger',
  trackingEpoch: 0,
  frame: { w: 1280, h: 720, mirrored: true },
  pixel: [640, 360],
  cameraMm: [10, 20, 500],
  state: 'tracked',
  fresh: true,
  reason: null,
  quality: { validPixels: 40, roiCount: 2, spreadMm: 12, pairSkewMs: 3 },
  ...overrides,
});

describe('spatial protocol parsing', () => {
  it('accepts a valid tracked payload', () => {
    const message = parseSpatialMessage(spatial()) as SpatialMessage;
    expect(message.v).toBe(2);
    expect(message.cameraMm).toEqual([10, 20, 500]);
    expect(message.frame.mirrored).toBe(true);
    expect(message.fresh).toBe(true);
  });

  it('rejects malformed, non-finite, wrong-version and inconsistent payloads', () => {
    expect(parseSpatialMessage(spatial({ v: 1 }))).toBeNull();
    expect(parseSpatialMessage(spatial({ cameraMm: [Number.NaN, 0, 1] }))).toBeNull();
    expect(parseSpatialMessage(spatial({ t: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(parseSpatialMessage(spatial({ state: 'held', fresh: true }))).toBeNull();
    expect(parseSpatialMessage(spatial({ state: 'tracked', cameraMm: null }))).toBeNull();
    expect(parseSpatialMessage(spatial({ state: 'lost', fresh: false, cameraMm: null, sampleTimeMs: null, ageMs: 1 }))).toBeNull();
    expect(parseSpatialMessage(spatial({ target: 'bogus' }))).toBeNull();
    expect(parseSpatialMessage(spatial({ pixel: [2000, 10] }))).toBeNull();
  });

  it('rejects duplicate and out-of-order samples on the same stream', () => {
    const state: SpatialParseState = { streamId: null, lastSeq: null, lastT: null };
    expect(parseSpatialMessage(spatial({ seq: 1, t: 1000 }), state)).not.toBeNull();
    expect(parseSpatialMessage(spatial({ seq: 1, t: 1010 }), state)).toBeNull();
    expect(parseSpatialMessage(spatial({ seq: 2, t: 990 }), state)).toBeNull();
    expect(parseSpatialMessage(spatial({ seq: 2, t: 1010 }), state)).not.toBeNull();
    expect(parseSpatialMessage(spatial({ streamId: 's2', seq: 1, t: 50, sampleTimeMs: 50, ageMs: 0 }), state)).not.toBeNull();
  });

  it('keeps a held XYZ without freshness', () => {
    const message = parseSpatialMessage(spatial({ state: 'held', fresh: false, reason: 'no_depth' }));
    expect(message?.fresh).toBe(false);
    expect(message?.cameraMm).toEqual([10, 20, 500]);
  });
});

describe('clock synchronization', () => {
  it('uses the lowest-RTT lower bound and fails closed when unsynced', () => {
    const clock = new ClockSync();
    expect(clock.ageUpperBoundMs(1000, 1100)).toBeNull();
    clock.observe(2000, 2040, 1000);
    expect(clock.offsetLower).toBe(1000);
    clock.observe(2100, 2180, 1100);
    expect(clock.rttMs).toBe(40);
    expect(clock.offsetLower).toBe(1000);
    clock.observe(3000, 3010, 1990);
    expect(clock.rttMs).toBe(10);
    expect(clock.offsetLower).toBe(1010);
    const age = clock.ageUpperBoundMs(1990, 3050, 5, 3010);
    expect(age).toBeGreaterThanOrEqual(50);
    expect(age).toBe(Math.max(3050 - 1990 - 1010, 5 + 40));
  });
});
