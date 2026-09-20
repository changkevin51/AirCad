import { describe, expect, it, vi } from 'vitest';
import { Commands } from '../model/commands';
import { ExtrusionSession } from '../model/extrusion';
import { profileFaces, type ProfileFace } from '../model/faces';
import { WorkPlane, type PlaneKind } from '../model/plane';
import { makeRect, rectFrame, Sketch, type ExtrusionEntity, type LineEntity, type ProfileEntity } from '../model/sketch';
import type { SnapResult } from '../model/snap';
import { StrokeSession } from '../model/stroke';
import { add, distance, nearlyEqual, scale, v2, v3, type Vec3 } from '../model/vec';
import { captureVoiceTarget, dispatchVoiceCommand, parseVoiceCommand, sameVoiceTarget } from './commands';

const ORIGIN = v3(100, 200, 300);
const UP = v2(0, -1);

const PLANE_AXES: Record<PlaneKind, { u: Vec3; v: Vec3; normal: 'x' | 'y' | 'z' }> = {
  XY: { u: v3(1, 0, 0), v: v3(0, 1, 0), normal: 'z' },
  XZ: { u: v3(1, 0, 0), v: v3(0, 0, 1), normal: 'y' },
  YZ: { u: v3(0, 1, 0), v: v3(0, 0, 1), normal: 'x' },
};

const directionAt = (kind: PlaneKind, degrees: number): Vec3 => {
  const { u, v } = PLANE_AXES[kind];
  const angle = (degrees * Math.PI) / 180;
  return add(scale(u, Math.cos(angle)), scale(v, Math.sin(angle)));
};

const snapOn = (plane: WorkPlane, world: Vec3): SnapResult => ({
  type: 'free',
  world,
  plane: plane.toPlane(world),
  screen: plane.toPlane(world),
  onPlane: true,
  raw: world,
});

function strokeOn(kind: PlaneKind, direction: Vec3, rough = 37): StrokeSession {
  const plane = new WorkPlane(kind, ORIGIN);
  const session = new StrokeSession(plane, snapOn(plane, ORIGIN));
  const end = add(ORIGIN, scale(direction, rough));
  session.add(snapOn(plane, end), end, plane.toPlane(end), 0);
  return session;
}

function pullFixture(options: { depth?: number; flat?: boolean; faceIndex?: number; movePx?: number; step?: number; u?: Vec3; v?: Vec3 } = {}) {
  const sketch = new Sketch();
  const commands = new Commands(sketch);
  const rect = commands.addRect(makeRect(ORIGIN, options.u ?? v3(1, 0, 0), options.v ?? v3(0, 1, 0), 200, 100));
  if (!rect.ok) throw new Error('fixture setup failed');
  let profile = rect.entity as ProfileEntity;
  if (!options.flat) {
    const solid = commands.extrude(profile.id, options.depth ?? 80);
    if (!solid.ok) throw new Error('fixture setup failed');
    profile = solid.entity as ProfileEntity;
  }
  const session = new ExtrusionSession(profile, 1, options.step ?? 0, options.faceIndex ?? 0);
  session.update(v2(300, 300), true, 'mouse', UP);
  session.update(v2(300, 300 - (options.movePx ?? 37)), true, 'mouse', UP);
  return { sketch, commands, profile, session };
}

const faceOn = (profile: ProfileEntity, axis: ProfileFace['axis'], sign: ProfileFace['sign']): ProfileFace =>
  profileFaces(profile).find((face) => face.axis === axis && face.sign === sign)!;

function expectFaceMove(before: ProfileEntity, after: ProfileEntity, faceIndex: number, signed: number): void {
  const face = profileFaces(before)[faceIndex];
  const moved = faceOn(after, face.axis, face.sign);
  const opposite = faceOn(after, face.axis, -face.sign as ProfileFace['sign']);
  const oldOpposite = faceOn(before, face.axis, -face.sign as ProfileFace['sign']);
  expect(nearlyEqual(moved.center, add(face.center, scale(face.normal, signed)), 1e-6)).toBe(true);
  expect(nearlyEqual(opposite.center, oldOpposite.center, 1e-6)).toBe(true);
  const beforeFrame = rectFrame(before);
  const afterFrame = rectFrame(after);
  if (face.axis !== 'u') expect(afterFrame.width).toBeCloseTo(beforeFrame.width, 9);
  if (face.axis !== 'v') expect(afterFrame.height).toBeCloseTo(beforeFrame.height, 9);
  const beforeDepth = before.type === 'extrusion' ? before.depth : 0;
  const afterDepth = after.type === 'extrusion' ? after.depth : 0;
  if (face.axis !== 'n') expect(Math.abs(afterDepth)).toBeCloseTo(Math.abs(beforeDepth), 9);
  if (before.type === 'extrusion' && Math.abs(before.depth) > 1e-9) {
    expect(after.type).toBe('extrusion');
    expect(Math.sign((after as ExtrusionEntity).depth)).toBe(Math.sign(before.depth));
  }
}

describe('parseVoiceCommand', () => {
  it('accepts exactly one positive finite distance', () => {
    expect(parseVoiceCommand({ distance_mm: 500 })).toEqual({ distance_mm: 500 });
    expect(parseVoiceCommand({ distance_mm: 12.345 })).toEqual({ distance_mm: 12.345 });
    expect(parseVoiceCommand({ distance_mm: 1_000_000 })).toEqual({ distance_mm: 1_000_000 });
  });

  it('rejects anything that is not a bare positive distance', () => {
    const invalid: unknown[] = [
      null, undefined, [], [500], '500', 42, true, {},
      { distance_mm: '500' }, { distance_mm: true }, { distance_mm: null }, { distance_mm: [500] },
      { distance_mm: 0 }, { distance_mm: -50 }, { distance_mm: 1e-6 }, { distance_mm: 1_000_001 },
      { distance_mm: NaN }, { distance_mm: Infinity }, { distance_mm: -Infinity },
      { distance_mm: 500, axis: 'x' },
      { distance_mm: 500, target: 'current_object' },
      { action: 'resize', target: 'current_object', axis: 'z', mode: 'delta', value_mm: 50 },
    ];
    for (const value of invalid) {
      expect(() => parseVoiceCommand(value)).toThrow('Say one positive distance, such as 500 mm or by 1 m');
    }
  });
});

describe('captureVoiceTarget', () => {
  it('captures a measured line on every work plane', () => {
    for (const kind of ['XY', 'XZ', 'YZ'] as const) {
      const session = strokeOn(kind, directionAt(kind, 37.3));
      const target = captureVoiceTarget(session, null, true);
      expect(target.source).toBe(session);
      expect(target.operation.kind).toBe('line');
      expect(target.context).toEqual({ operation: 'line', units: 'mm' });
      expect(target.description).toBe(`Line · ${kind} · 37.3°`);
      expect(target.signature).toBe(JSON.stringify(target.operation));
      if (target.operation.kind === 'line') {
        expect(target.operation.measurement.start).toEqual(ORIGIN);
        expect(target.operation.measurement.previewLength).toBeCloseTo(37);
      }
      expect(sameVoiceTarget(target, captureVoiceTarget(session, null, true))).toBe(true);
    }
  });

  it('rejects an idle app, a busy app, and strokes without a clear direction', () => {
    expect(() => captureVoiceTarget(null, null, true)).toThrow();
    const session = strokeOn('XY', v3(1, 0, 0));
    expect(() => captureVoiceTarget(session, null, false)).toThrow('Finish the current operation');
    const plane = new WorkPlane('XY', ORIGIN);
    const fresh = new StrokeSession(plane, snapOn(plane, ORIGIN));
    const near = add(ORIGIN, v3(5, 0, 0));
    fresh.add(snapOn(plane, near), near, v2(105, 200), 0);
    expect(() => captureVoiceTarget(fresh, null, true)).toThrow();
  });

  it('captures the grabbed face with its baseline geometry and direction', () => {
    const { profile, session } = pullFixture({ depth: 80, faceIndex: 2 });
    const target = captureVoiceTarget(null, session, true);
    expect(target.source).toBe(session);
    expect(target.context).toEqual({ operation: 'face_pull', units: 'mm' });
    expect(target.description).toBe('right face · outward');
    if (target.operation.kind !== 'face_pull') throw new Error('expected face_pull');
    expect(target.operation.measurement.axis).toBe('u');
    expect(target.operation.measurement.sign).toBe(1);
    expect(target.operation.measurement.direction).toBe(1);
    expect(target.operation.measurement.base).toEqual(profile);
    expect(target.operation.profile).toEqual(profile);
    expect(target.operation.profile).not.toBe(profile);
  });

  it('rejects a face pull without a clear grab direction', () => {
    const { session } = pullFixture({ depth: 80, movePx: 5 });
    expect(session.measurement).toBeNull();
    expect(() => captureVoiceTarget(null, session, true)).toThrow();
  });
});

describe('dispatchVoiceCommand: line', () => {
  it.each(['XY', 'XZ', 'YZ'] as const)('creates an exact 500 mm line along the measured direction on %s', (kind) => {
    const direction = directionAt(kind, 53.13);
    const session = strokeOn(kind, direction);
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const before = sketch.serialize();
    const target = captureVoiceTarget(session, null, true);
    const result = dispatchVoiceCommand({ distance_mm: 500 }, target, commands, captureVoiceTarget(session, null, true));
    expect(result).toMatchObject({ ok: true, message: `Created 500 mm line on ${kind}` });
    const line = sketch.last as LineEntity;
    expect(line.type).toBe('line');
    expect(nearlyEqual(line.a, ORIGIN, 1e-9)).toBe(true);
    const expected = add(ORIGIN, scale(direction, 500));
    expect(nearlyEqual(line.b, expected, 1e-9)).toBe(true);
    expect(line.b[PLANE_AXES[kind].normal]).toBeCloseTo(ORIGIN[PLANE_AXES[kind].normal], 9);
    expect(distance(line.a, line.b)).toBeCloseTo(500, 9);
    expect(distance(line.a, line.b)).not.toBeCloseTo(537, 6);
    expect(commands.undo()).toBeTruthy();
    expect(sketch.serialize()).toBe(before);
    expect(commands.redo()).toBeTruthy();
    expect(nearlyEqual((sketch.last as LineEntity).b, expected, 1e-9)).toBe(true);
  });

  it.each(['XY', 'XZ', 'YZ'] as const)('follows any angle, including diagonals, reversals and pure axis directions on %s', (kind) => {
    for (const degrees of [30, 45, 60, 37.3, 90, -90, 180]) {
      const direction = directionAt(kind, degrees);
      const session = strokeOn(kind, direction);
      const sketch = new Sketch();
      const commands = new Commands(sketch);
      const target = captureVoiceTarget(session, null, true);
      const result = dispatchVoiceCommand({ distance_mm: 250 }, target, commands, target);
      expect(result.ok).toBe(true);
      const line = sketch.last as LineEntity;
      expect(nearlyEqual(line.a, ORIGIN, 1e-9)).toBe(true);
      expect(nearlyEqual(line.b, add(ORIGIN, scale(direction, 250)), 1e-9)).toBe(true);
      expect(line.b[PLANE_AXES[kind].normal]).toBeCloseTo(ORIGIN[PLANE_AXES[kind].normal], 9);
    }
  });

  it('uses the raw in-plane ray point of a grid-only snap for the voice direction', () => {
    const plane = new WorkPlane('XY', ORIGIN);
    const session = new StrokeSession(plane, snapOn(plane, ORIGIN));
    const raw = v3(130, 240, 300);
    const snap: SnapResult = { ...snapOn(plane, v3(200, 200, 300)), type: 'grid', raw };
    session.add(snap, raw, v2(130, 240), 0);
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const target = captureVoiceTarget(session, null, true);
    const result = dispatchVoiceCommand({ distance_mm: 500 }, target, commands, target);
    expect(result.ok).toBe(true);
    const line = sketch.last as LineEntity;
    expect(nearlyEqual(line.b, v3(400, 600, 300), 1e-9)).toBe(true);
    expect(distance(line.a, line.b)).toBeCloseTo(500, 9);
  });

  it('rejects stale, missing or tampered captures before any commit hook or model write', () => {
    const session = strokeOn('XY', v3(1, 0, 0));
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const target = captureVoiceTarget(session, null, true);
    const beforeCommit = vi.fn();

    expect(dispatchVoiceCommand({ distance_mm: 100 }, target, commands, null, beforeCommit).ok).toBe(false);
    const other = captureVoiceTarget(strokeOn('XY', v3(0, 1, 0)), null, true);
    expect(dispatchVoiceCommand({ distance_mm: 100 }, target, commands, other, beforeCommit).ok).toBe(false);

    if (target.operation.kind !== 'line') throw new Error('expected line');
    target.operation.measurement.start = v3(0, 0, 0);
    expect(dispatchVoiceCommand({ distance_mm: 100 }, target, commands, target, beforeCommit).ok).toBe(false);
    expect(beforeCommit).not.toHaveBeenCalled();
    expect(sketch.size).toBe(0);
  });

  it.each(['XY', 'XZ', 'YZ'] as const)('uses a refined near-axis free angle for an exact 5000 mm line on %s', (kind) => {
    const plane = new WorkPlane(kind, ORIGIN);
    const session = new StrokeSession(plane, snapOn(plane, ORIGIN));
    const wobble = add(ORIGIN, add(scale(plane.u, 8), scale(plane.v, 18)));
    session.add(snapOn(plane, wobble), wobble, plane.toPlane(wobble), 0);
    for (let i = 1; i <= 12; i += 1) {
      const along = 50 + 5 * i;
      const raw = add(ORIGIN, add(scale(plane.u, along), scale(plane.v, along * 0.07)));
      const snapped = add(ORIGIN, scale(plane.u, along));
      session.add({ ...snapOn(plane, snapped), type: 'axis', axis: 'u', raw }, raw, plane.toPlane(raw), 0);
    }
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const before = sketch.serialize();
    const target = captureVoiceTarget(session, null, true);
    expect(dispatchVoiceCommand({ distance_mm: 5000 }, target, commands, captureVoiceTarget(session, null, true)).ok).toBe(true);
    const line = sketch.last as LineEntity;
    const direction = directionAt(kind, Math.atan2(7, 100) * 180 / Math.PI);
    expect(nearlyEqual(line.b, add(ORIGIN, scale(direction, 5000)), 1e-8)).toBe(true);
    expect(distance(line.a, line.b)).toBeCloseTo(5000, 9);
    expect(line.b[PLANE_AXES[kind].normal]).toBe(ORIGIN[PLANE_AXES[kind].normal]);
    commands.undo();
    expect(sketch.serialize()).toBe(before);
  });

  it('rejects a capture if further aiming changes its source session', () => {
    const session = strokeOn('XY', v3(0.6, 0.8, 0));
    const target = captureVoiceTarget(session, null, true);
    const next = add(ORIGIN, v3(-40, 60, 0));
    session.add(snapOn(session.plane, next), next, session.plane.toPlane(next), 0);
    const current = captureVoiceTarget(session, null, true);
    const sketch = new Sketch();
    const commands = new Commands(sketch);
    const beforeCommit = vi.fn();
    expect(sameVoiceTarget(target, current)).toBe(false);
    expect(dispatchVoiceCommand({ distance_mm: 5000 }, target, commands, current, beforeCommit).ok).toBe(false);
    expect(beforeCommit).not.toHaveBeenCalled();
    expect(sketch.size).toBe(0);
  });
});

describe('dispatchVoiceCommand: face pull', () => {
  it('moves each of the six box faces exactly the spoken distance while the opposite face stays fixed', () => {
    for (const depth of [80, -80]) {
      for (let faceIndex = 0; faceIndex < 6; faceIndex += 1) {
        for (const movePx of [37, -37]) {
          const { sketch, commands, profile, session } = pullFixture({ depth, faceIndex, movePx });
          const signed = (movePx > 0 ? 1 : -1) * 12.345;
          const before = sketch.serialize();
          const target = captureVoiceTarget(null, session, true);
          const result = dispatchVoiceCommand({ distance_mm: 12.345 }, target, commands, captureVoiceTarget(null, session, true));
          expect(result).toMatchObject({ ok: true });
          const updated = sketch.get(profile.id) as ExtrusionEntity;
          expectFaceMove(profile, updated, faceIndex, signed);
          expect(commands.undo()).toBeTruthy();
          expect(sketch.serialize()).toBe(before);
        }
      }
    }
  });

  it('moves rotated faces along their own normals', () => {
    const u = v3(0.8, 0.6, 0);
    const v = v3(-0.6, 0.8, 0);
    for (let faceIndex = 0; faceIndex < 6; faceIndex += 1) {
      for (const movePx of [37, -37]) {
        const { sketch, commands, profile, session } = pullFixture({ depth: 80, faceIndex, movePx, u, v });
        const signed = (movePx > 0 ? 1 : -1) * 12.345;
        const before = sketch.serialize();
        const target = captureVoiceTarget(null, session, true);
        expect(dispatchVoiceCommand({ distance_mm: 12.345 }, target, commands, target).ok).toBe(true);
        expectFaceMove(profile, sketch.get(profile.id) as ExtrusionEntity, faceIndex, signed);
        expect(commands.undo()).toBeTruthy();
        expect(sketch.serialize()).toBe(before);
      }
    }
  });

  it('extrudes a flat rectangle to either side through either normal face', () => {
    for (const faceIndex of [0, 1]) {
      for (const movePx of [37, -37]) {
        const { sketch, commands, profile, session } = pullFixture({ flat: true, faceIndex, movePx });
        const face = profileFaces(profile)[faceIndex];
        const signed = (movePx > 0 ? 1 : -1) * 50;
        const before = sketch.serialize();
        const target = captureVoiceTarget(null, session, true);
        const result = dispatchVoiceCommand({ distance_mm: 50 }, target, commands, target);
        expect(result.ok).toBe(true);
        const updated = sketch.get(profile.id) as ExtrusionEntity;
        expect(updated.type).toBe('extrusion');
        expect(updated.depth).toBeCloseTo(face.sign * signed, 9);
        expect(Math.abs(updated.depth)).toBeCloseTo(50, 9);
        expect(commands.undo()).toBeTruthy();
        expect(sketch.serialize()).toBe(before);
      }
    }
  });

  it('measures from the current grab baseline, not the preview or an earlier grab', () => {
    const { sketch, commands, profile, session } = pullFixture({ flat: true, movePx: 20 });
    expect(session.preview.depth).toBeCloseTo(20);
    session.update(v2(300, 280), false, 'mouse', UP);
    session.update(v2(500, 500), true, 'mouse', UP);
    session.update(v2(500, 463), true, 'mouse', UP);
    expect(session.preview.depth).toBeCloseTo(57);
    const target = captureVoiceTarget(null, session, true);
    const result = dispatchVoiceCommand({ distance_mm: 10 }, target, commands, target);
    expect(result.ok).toBe(true);
    expect((sketch.get(profile.id) as ExtrusionEntity).depth).toBeCloseTo(30, 9);
  });

  it('applies the spoken distance exactly, ignoring the gesture grid step', () => {
    const { sketch, commands, profile, session } = pullFixture({ depth: 80, faceIndex: 2, movePx: 37, step: 100 });
    const target = captureVoiceTarget(null, session, true);
    const result = dispatchVoiceCommand({ distance_mm: 12.345 }, target, commands, target);
    expect(result.ok).toBe(true);
    expect(rectFrame(sketch.get(profile.id) as ExtrusionEntity).width).toBeCloseTo(212.345, 9);
  });

  it('applies an inward pull smaller than the grid step exactly while positive', () => {
    const { sketch, commands, profile, session } = pullFixture({ depth: 80, faceIndex: 2, movePx: -37, step: 100 });
    const target = captureVoiceTarget(null, session, true);
    const result = dispatchVoiceCommand({ distance_mm: 12.345 }, target, commands, target);
    expect(result.ok).toBe(true);
    expect(rectFrame(sketch.get(profile.id) as ExtrusionEntity).width).toBeCloseTo(187.655, 9);
  });

  it('rejects collapse, inversion and over-limit pulls without touching the model or history', () => {
    for (const [faceIndex, movePx, distanceMm] of [
      [0, -37, 80],
      [0, -37, 200],
      [1, 37, 999_950],
      [2, -37, 200],
      [2, -37, 250],
      [4, -37, 100],
    ] as const) {
      const { sketch, commands, session } = pullFixture({ depth: 80, faceIndex, movePx });
      const before = sketch.serialize();
      const target = captureVoiceTarget(null, session, true);
      const beforeCommit = vi.fn();
      const result = dispatchVoiceCommand({ distance_mm: distanceMm }, target, commands, target, beforeCommit);
      expect(result.ok).toBe(false);
      expect(beforeCommit).not.toHaveBeenCalled();
      expect(sketch.serialize()).toBe(before);
      expect(commands.undo()).toMatch(/add rect|extrude/);
    }
  });

  it('rejects invalid commands and tampered snapshots without committing', () => {
    const { sketch, commands, session } = pullFixture({ depth: 80 });
    const before = sketch.serialize();
    const target = captureVoiceTarget(null, session, true);
    const beforeCommit = vi.fn();
    for (const value of [null, { distance_mm: 0 }, { distance_mm: -5 }, { distance_mm: NaN }, { distance_mm: Infinity }, { distance_mm: 1_000_001 }, { distance_mm: 50, axis: 'z' }]) {
      expect(dispatchVoiceCommand(value, target, commands, target, beforeCommit).ok).toBe(false);
    }
    expect(dispatchVoiceCommand({ distance_mm: 50 }, target, commands, null, beforeCommit).ok).toBe(false);
    expect(beforeCommit).not.toHaveBeenCalled();
    expect(sketch.serialize()).toBe(before);
  });
});
