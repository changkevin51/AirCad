import { add, clone, isFinite3, ORIGIN, v3, type Vec3 } from '../model/vec';
import type { SpatialMessage } from './tracker-client';
import { ClockSync } from './tracker-client';

export const SCALE_PRESETS = [1, 5, 10, 50, 100] as const;
export type ScalePreset = (typeof SCALE_PRESETS)[number];

export const CALIBRATION_WINDOW_MS = 400;
export const CALIBRATION_TIMEOUT_MS = 5000;
export const CALIBRATION_MIN_SAMPLES = 8;
export const CALIBRATION_MAX_SPREAD_MM = 10;
/** Target depth from an OAK often jitters more than 10 mm; still accept a cluster. */
export const CALIBRATION_FALLBACK_SPREAD_MM = 30;
export const MAX_DRAW_AGE_MS = 200;

/** cameraMm is unmirrored camera X-right / Y-up / Z-forward millimetres. */
export function cameraMmToWorld(cameraMm: Vec3, cameraAnchor: Vec3, worldAnchor: Vec3, scale: number): Vec3 {
  const q = v3(cameraMm.x - cameraAnchor.x, cameraMm.y - cameraAnchor.y, cameraMm.z - cameraAnchor.z);
  return add(worldAnchor, v3(-q.x * scale, q.z * scale, q.y * scale));
}

export function tupleToVec3(tuple: [number, number, number]): Vec3 {
  return v3(tuple[0], tuple[1], tuple[2]);
}

export function medianVec3(samples: readonly Vec3[]): Vec3 {
  const axis = (pick: (p: Vec3) => number): number => {
    const values = samples.map(pick).sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  };
  return v3(axis((p) => p.x), axis((p) => p.y), axis((p) => p.z));
}

export function spreadVec3(samples: readonly Vec3[]): Vec3 {
  const axis = (pick: (p: Vec3) => number): number => {
    const values = samples.map(pick);
    return Math.max(...values) - Math.min(...values);
  };
  return v3(axis((p) => p.x), axis((p) => p.y), axis((p) => p.z));
}

export class SpatialMapping {
  scale: number = 1;
  cameraAnchor: Vec3 | null = null;
  worldAnchor: Vec3 = { ...ORIGIN };
  sourceRunId: string | null = null;
  revision = 0;

  get calibrated(): boolean {
    return this.cameraAnchor !== null;
  }

  toWorld(cameraMm: Vec3): Vec3 | null {
    if (!this.cameraAnchor || !isFinite3(cameraMm)) return null;
    return cameraMmToWorld(cameraMm, this.cameraAnchor, this.worldAnchor, this.scale);
  }

  setOrigin(cameraMm: Vec3): void {
    this.cameraAnchor = clone(cameraMm);
    this.worldAnchor = { ...ORIGIN };
    this.revision++;
  }

  recenter(cameraMm: Vec3, world: Vec3): void {
    this.cameraAnchor = clone(cameraMm);
    this.worldAnchor = clone(world);
    this.revision++;
  }

  /** Change scale; with an established mapping, reanchor so the cursor does not jump. */
  setScale(scale: number, currentCameraMm?: Vec3 | null): void {
    if (!SCALE_PRESETS.includes(scale as ScalePreset)) return;
    if (this.calibrated && currentCameraMm) {
      const world = this.toWorld(currentCameraMm);
      this.scale = scale;
      if (world) {
        this.cameraAnchor = clone(currentCameraMm);
        this.worldAnchor = world;
      }
    } else {
      this.scale = scale;
    }
    this.revision++;
  }

  /** Drop calibration when the physical camera run changes. */
  invalidateRun(sourceRunId: string | null): boolean {
    if (sourceRunId === this.sourceRunId) return false;
    const previous = this.sourceRunId;
    this.sourceRunId = sourceRunId;
    if (previous === null) return false;
    this.cameraAnchor = null;
    this.worldAnchor = { ...ORIGIN };
    this.revision++;
    return true;
  }
}

export type CalibrationPhase = 'idle' | 'collecting' | 'done' | 'timeout';

export class CalibrationCapture {
  samples: Vec3[] = [];
  startedAt: number | null = null;
  phase: CalibrationPhase = 'idle';

  get progress(): number {
    if (this.startedAt === null) return 0;
    return Math.min(1, this.samples.length / CALIBRATION_MIN_SAMPLES);
  }

  start(nowMs: number): void {
    this.samples = [];
    this.startedAt = nowMs;
    this.phase = 'collecting';
  }

  cancel(): void {
    this.samples = [];
    this.startedAt = null;
    this.phase = 'idle';
  }

  add(cameraMm: Vec3, nowMs: number, fresh: boolean): CalibrationPhase {
    if (this.phase !== 'collecting' || this.startedAt === null) return this.phase;
    if (nowMs - this.startedAt > CALIBRATION_TIMEOUT_MS) {
      return this.finishOrTimeout();
    }
    if (!fresh || !isFinite3(cameraMm)) return this.phase;
    this.samples.push(clone(cameraMm));
    if (nowMs - this.startedAt < CALIBRATION_WINDOW_MS) return this.phase;
    if (this.acceptWindow(CALIBRATION_MAX_SPREAD_MM) || this.acceptWindow(CALIBRATION_FALLBACK_SPREAD_MM)) {
      this.phase = 'done';
    }
    return this.phase;
  }

  /** Median of the tightest recent window, or all samples if shorter. */
  median(): Vec3 | null {
    const window = this.tightestWindow();
    return window.length ? medianVec3(window) : null;
  }

  private finishOrTimeout(): CalibrationPhase {
    if (this.acceptWindow(CALIBRATION_FALLBACK_SPREAD_MM) || this.samples.length > 0) {
      const window = this.tightestWindow();
      if (window.length) this.samples = window;
      this.phase = this.samples.length ? 'done' : 'timeout';
      return this.phase;
    }
    this.phase = 'timeout';
    return this.phase;
  }

  private acceptWindow(maxSpread: number): boolean {
    const window = this.tightestWindow();
    if (window.length < CALIBRATION_MIN_SAMPLES) return false;
    const spread = spreadVec3(window);
    return spread.x <= maxSpread && spread.y <= maxSpread && spread.z <= maxSpread;
  }

  private tightestWindow(): Vec3[] {
    if (this.samples.length <= CALIBRATION_MIN_SAMPLES) return this.samples.slice();
    let best = this.samples.slice(-CALIBRATION_MIN_SAMPLES);
    let bestScore = spreadScore(spreadVec3(best));
    for (let start = 0; start + CALIBRATION_MIN_SAMPLES <= this.samples.length; start++) {
      const window = this.samples.slice(start, start + CALIBRATION_MIN_SAMPLES);
      const score = spreadScore(spreadVec3(window));
      if (score < bestScore) {
        best = window;
        bestScore = score;
      }
    }
    return best;
  }
}

function spreadScore(spread: Vec3): number {
  return Math.max(spread.x, spread.y, spread.z);
}

export type SpatialCursorState = 'acquiring' | 'tracked' | 'held' | 'lost' | 'origin';

export class SpatialCursorSource {
  readonly mapping = new SpatialMapping();
  readonly calibration = new CalibrationCapture();
  last: SpatialMessage | null = null;
  lastTrusted: SpatialMessage | null = null;
  receivedAt = 0;
  cameraMm: Vec3 | null = null;
  world: Vec3 | null = null;
  pixel: [number, number] | null = null;
  streamId: string | null = null;
  trackingEpoch = 0;
  reason: string | null = null;

  constructor(
    private readonly clock: ClockSync,
    private readonly now: () => number = () => performance.now(),
  ) {}

  apply(message: SpatialMessage, nowMs = this.now()): void {
    if (this.streamId && message.streamId !== this.streamId) {
      this.resetContinuity();
    }
    this.mapping.invalidateRun(message.sourceRunId);
    this.streamId = message.streamId;
    this.trackingEpoch = message.trackingEpoch;
    this.last = message;
    this.receivedAt = nowMs;
    this.pixel = message.pixel;
    this.reason = message.reason;
    if (message.cameraMm) {
      this.cameraMm = tupleToVec3(message.cameraMm);
      this.world = this.mapping.toWorld(this.cameraMm);
    } else {
      this.cameraMm = null;
      this.world = null;
    }
    if (message.state === 'tracked' && message.fresh && message.sampleTimeMs !== null) {
      this.lastTrusted = message;
    }
    // Origin capture uses the wire-fresh tracked point. Client clock sync can
    // stay fail-closed for drawing without blocking calibration.
    const wireFresh = message.state === 'tracked' && message.fresh && !!this.cameraMm;
    if (this.calibration.phase === 'collecting' && wireFresh && this.cameraMm) {
      this.calibration.add(this.cameraMm, nowMs, true);
    }
  }

  resetContinuity(): void {
    this.last = null;
    this.lastTrusted = null;
    this.cameraMm = null;
    this.world = null;
    this.pixel = null;
    this.reason = null;
    this.trackingEpoch = 0;
    this.calibration.cancel();
  }

  isFresh(nowMs = this.now()): boolean {
    const message = this.last;
    if (!message || !message.fresh || message.state !== 'tracked' || message.sampleTimeMs === null) return false;
    const age = this.clock.ageUpperBoundMs(message.sampleTimeMs, nowMs, message.ageMs, this.receivedAt);
    if (age === null || age > MAX_DRAW_AGE_MS) return false;
    return true;
  }

  identity(): { streamId: string; sourceRunId: string; trackingEpoch: number; mappingRevision: number } | null {
    const message = this.last;
    if (!message) return null;
    return {
      streamId: message.streamId,
      sourceRunId: message.sourceRunId,
      trackingEpoch: message.trackingEpoch,
      mappingRevision: this.mapping.revision,
    };
  }

  hudState(nowMs = this.now()): SpatialCursorState {
    if (!this.mapping.calibrated) return 'origin';
    if (this.isFresh(nowMs)) return 'tracked';
    const state = this.last?.state;
    if (state === 'held') return 'held';
    if (state === 'lost') return 'lost';
    return 'acquiring';
  }
}

export function sameIdentity(
  a: { streamId: string; sourceRunId: string; trackingEpoch: number; mappingRevision: number },
  b: { streamId: string; sourceRunId: string; trackingEpoch: number; mappingRevision: number },
): boolean {
  return (
    a.streamId === b.streamId &&
    a.sourceRunId === b.sourceRunId &&
    a.trackingEpoch === b.trackingEpoch &&
    a.mappingRevision === b.mappingRevision
  );
}
