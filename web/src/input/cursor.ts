import { v2, type Vec2 } from '../model/vec';
import type { OneEuroOptions } from './one-euro';
import { KeycapFilter } from './keycap-filter';
import type { KeycapMessage, TrackedKeycapMessage } from './tracker-client';

export interface Size {
  w: number;
  h: number;
}

/** Fraction of the camera frame ignored on each side: the centre maps to the full viewport. */
export const REGION_MARGIN = 0.12;
export const KEYCAP_RECOVERY_S = 0.25;

export interface RegionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The camera-frame rectangle that maps onto the viewport, in frame pixels. */
export function regionRect(frame: Size, margin = REGION_MARGIN): RegionRect {
  return { x: frame.w * margin, y: frame.h * margin, w: frame.w * (1 - 2 * margin), h: frame.h * (1 - 2 * margin) };
}

/** Map a keycap center in camera-frame pixels to viewport pixels, clamped to the viewport. */
export function mapFrameToViewport(center: Vec2, frame: Size, viewport: Size, margin = REGION_MARGIN): Vec2 {
  const region = regionRect(frame, margin);
  const nx = region.w > 0 ? (center.x - region.x) / region.w : 0.5;
  const ny = region.h > 0 ? (center.y - region.y) / region.h : 0.5;
  return v2(Math.min(viewport.w, Math.max(0, nx * viewport.w)), Math.min(viewport.h, Math.max(0, ny * viewport.h)));
}

/**
 * Choose the keycap that drives the cursor: stick to the current one while it
 * is visible, otherwise acquire the detected keycap.
 */
export function pickCursorKeycap(keycaps: readonly TrackedKeycapMessage[], currentId: number | null): TrackedKeycapMessage | null {
  if (!keycaps.length) return null;
  const current = currentId === null ? undefined : keycaps.find((keycap) => keycap.id === currentId);
  if (current) return current;
  return keycaps[0];
}

export type TrackingState = 'none' | 'keycap' | 'lost' | 'mouse';

/**
 * Merges the tracked keycap center and the mouse into one cursor.  The keycap has
 * priority; the mouse takes over once no keycap has been seen for a moment,
 * which also makes the whole app usable (and testable) without a webcam.
 */
export class CursorSource {
  position: Vec2 | null = null;
  tracking: TrackingState = 'none';
  keycapId: number | null = null;
  /** The keycap currently driving the cursor (raw message), if any. */
  keycap: TrackedKeycapMessage | null = null;
  private readonly filter: KeycapFilter;
  private lastKeycapSeenS = -Infinity;
  private lostSinceS = -Infinity;
  private lastMeasurement: TrackedKeycapMessage | null = null;
  private readonly keycapLossGraceS: number;

  constructor(filterOptions: Partial<OneEuroOptions> = {}, keycapLossGraceS = 0.3) {
    this.filter = new KeycapFilter(filterOptions);
    this.keycapLossGraceS = keycapLossGraceS;
  }

  updateKeycap(message: KeycapMessage, viewport: Size, nowS: number): void {
    const keycap = pickCursorKeycap(message.keycaps, this.keycapId);
    if (!keycap) {
      if (this.tracking === 'keycap') {
        this.tracking = 'lost';
        this.lostSinceS = nowS;
      }
      this.filter.reset();
      this.keycap = null;
      return;
    }
    if (this.tracking !== 'keycap' || keycap.id !== this.keycapId) this.filter.reset();
    this.keycapId = keycap.id;
    this.keycap = keycap;
    this.lastMeasurement = keycap;
    this.lastKeycapSeenS = nowS;
    const mapped = mapFrameToViewport(v2(keycap.center[0], keycap.center[1]), message.frame, viewport);
    // Camera time, not WebSocket delivery time, drives the adaptive filter.
    this.position = this.filter.filter(mapped, message.t / 1000);
    this.tracking = 'keycap';
  }

  /** Returns true when the mouse was accepted as the cursor source. */
  updateMouse(point: Vec2, nowS: number): boolean {
    if (this.tracking === 'keycap' && nowS - this.lastKeycapSeenS < this.keycapLossGraceS) return false;
    this.position = point;
    this.tracking = 'mouse';
    this.keycap = null;
    this.keycapId = null;
    this.lastMeasurement = null;
    return true;
  }

  /** Called when the tracker disconnects: forget the keycap so the mouse can drive. */
  dropKeycap(): void {
    if (this.tracking === 'keycap') this.tracking = 'lost';
    this.lostSinceS = -Infinity;
    this.keycapId = null;
    this.keycap = null;
    this.lastMeasurement = null;
  }

  get isLost(): boolean {
    return this.tracking === 'lost';
  }

  /** Retain a draft only briefly, without supplying a stale drawing sample. */
  canRecoverKeycap(nowS: number): boolean {
    return this.isLost && this.lastMeasurement !== null && nowS - this.lastKeycapSeenS <= KEYCAP_RECOVERY_S;
  }

  continuesKeycap(message: KeycapMessage, nowS: number): boolean {
    const target = message.keycaps[0];
    if (!this.canRecoverKeycap(nowS) || !target || target.id !== this.keycapId || !this.lastMeasurement) return false;
    const [x, y] = this.lastMeasurement.center;
    // A same-ID packet still cannot bridge a remote jump after a blind gap.
    return Math.hypot(target.center[0] - x, target.center[1] - y) <= Math.max(40, Math.max(message.frame.w, message.frame.h) * .15);
  }

  /** Debounce idle feedback only. Geometry always uses immediate isLost. */
  statusTracking(nowS: number): TrackingState {
    return this.isLost && nowS - this.lostSinceS < 0.25 ? 'keycap' : this.tracking;
  }
}
