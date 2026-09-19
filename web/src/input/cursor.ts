import { v2, type Vec2 } from '../model/vec';
import { OneEuroFilter2D, type OneEuroOptions } from './one-euro';
import type { HandsMessage, TrackedHandMessage } from './tracker-client';

export interface Size {
  w: number;
  h: number;
}

/** Fraction of the camera frame ignored on each side: the centre maps to the full viewport. */
export const REGION_MARGIN = 0.12;

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

/** Map a fingertip in camera-frame pixels to viewport pixels, clamped to the viewport. */
export function mapFrameToViewport(tip: Vec2, frame: Size, viewport: Size, margin = REGION_MARGIN): Vec2 {
  const region = regionRect(frame, margin);
  const nx = region.w > 0 ? (tip.x - region.x) / region.w : 0.5;
  const ny = region.h > 0 ? (tip.y - region.y) / region.h : 0.5;
  return v2(Math.min(viewport.w, Math.max(0, nx * viewport.w)), Math.min(viewport.h, Math.max(0, ny * viewport.h)));
}

/**
 * Choose the hand that drives the cursor: stick to the current one while it
 * is visible, otherwise prefer a hand that is not doing open-palm navigation.
 */
export function pickCursorHand(hands: readonly TrackedHandMessage[], currentId: number | null): TrackedHandMessage | null {
  if (!hands.length) return null;
  const current = currentId === null ? undefined : hands.find((hand) => hand.id === currentId);
  if (current) return current;
  return hands.find((hand) => !hand.openArmed) ?? hands[0];
}

export type TrackingState = 'none' | 'hand' | 'lost' | 'mouse';

/**
 * Merges the tracked fingertip and the mouse into one cursor.  The hand has
 * priority; the mouse takes over once no hand has been seen for a moment,
 * which also makes the whole app usable (and testable) without a webcam.
 */
export class CursorSource {
  position: Vec2 | null = null;
  tracking: TrackingState = 'none';
  handId: number | null = null;
  /** The hand currently driving the cursor (raw message), if any. */
  hand: TrackedHandMessage | null = null;
  private readonly filter: OneEuroFilter2D;
  private lastHandSeenS = -Infinity;
  private readonly handLossGraceS: number;

  constructor(filterOptions: Partial<OneEuroOptions> = {}, handLossGraceS = 0.3) {
    this.filter = new OneEuroFilter2D(filterOptions);
    this.handLossGraceS = handLossGraceS;
  }

  updateHands(message: HandsMessage, viewport: Size, nowS: number): void {
    const hand = pickCursorHand(message.hands, this.handId);
    if (!hand) {
      if (this.tracking === 'hand') this.tracking = 'lost';
      this.handId = null;
      this.hand = null;
      return;
    }
    if (this.tracking !== 'hand' || hand.id !== this.handId) this.filter.reset();
    this.handId = hand.id;
    this.hand = hand;
    this.lastHandSeenS = nowS;
    const mapped = mapFrameToViewport(v2(hand.tip[0], hand.tip[1]), message.frame, viewport);
    this.position = this.filter.filter(mapped, nowS);
    this.tracking = 'hand';
  }

  /** Returns true when the mouse was accepted as the cursor source. */
  updateMouse(point: Vec2, nowS: number): boolean {
    if (this.tracking === 'hand' && nowS - this.lastHandSeenS < this.handLossGraceS) return false;
    this.position = point;
    this.tracking = 'mouse';
    this.hand = null;
    return true;
  }

  /** Called when the tracker disconnects: forget the hand so the mouse can drive. */
  dropHand(): void {
    if (this.tracking === 'hand') this.tracking = 'lost';
    this.handId = null;
    this.hand = null;
  }

  get isLost(): boolean {
    return this.tracking === 'lost';
  }
}
