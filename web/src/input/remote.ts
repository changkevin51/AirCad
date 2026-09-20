/**
 * Four-button BLE pen remote ("Smart Pen").
 *
 * The firmware is a dumb transport: it reports button 1-4 press/release as
 * F13-F16 and nothing else.  Every mode, threshold and chord lives here, so the
 * HUD can show the current mode and the timings can be tuned without
 * reflashing.  Each gesture resolves to an action the keymap already defines;
 * this module never invents CAD behavior.
 *
 * `down`/`up` plus a per-frame `tick` drive the whole state machine, so there
 * are no timers to leak and the behavior is deterministic under test.
 *
 * Camera tracking still supplies the cursor: the buttons replace the pinch, not
 * the pointer.
 */
import type { HoldAction, PressAction } from './keymap';

export type RemoteButton = 1 | 2 | 3 | 4;

/** A mode is named after the hold action that button 1 engages in it. */
export type RemoteMode = 'draw' | 'orbit' | 'pan';

export const REMOTE_MODES: readonly RemoteMode[] = ['draw', 'orbit', 'pan'];

export const REMOTE_MODE_LABELS: Record<RemoteMode, string> = {
  draw: 'Draw',
  orbit: 'Orbit',
  pan: 'Pan',
};

/**
 * `KeyboardEvent.code` to button.  F13-F16 are unbound in the keymap, are not
 * printable (so they cannot type into the measure dialog or the inspector) and
 * are not claimed by macOS or Windows by default.
 */
export const REMOTE_CODES: Readonly<Record<string, RemoteButton>> = {
  F13: 1,
  F14: 2,
  F15: 3,
  F16: 4,
};

export function remoteButtonForCode(code: string): RemoteButton | null {
  return REMOTE_CODES[code] ?? null;
}

export interface RemoteTimings {
  /** Buttons 3 and 4: held at least this long resolves to the hold action. */
  holdMs: number;
  /** Button 1: released within this long is a tap, not a gesture. */
  tapMs: number;
  /** Button 1: a tap this soon after the previous tap is undo, not select. */
  doubleTapMs: number;
  /** Button 2 pressed this soon after 3 or 4 still counts as a chord. */
  chordMs: number;
}

/** Tunable by feel; every threshold the remote uses lives here. */
export const DEFAULT_REMOTE_TIMINGS: RemoteTimings = {
  holdMs: 180,
  tapMs: 180,
  doubleTapMs: 250,
  chordMs: 120,
};

export interface RemoteHandlers {
  hold(action: HoldAction, down: boolean): void;
  press(action: PressAction): void;
  /** Hold to talk: `true` opens the recognizer, `false` finalizes it. */
  voice(down: boolean): void;
  /** Hold to move: `true` starts the move and takes the grab, `false` applies it. */
  move(down: boolean): void;
  /** A tap must never commit the gesture it opened. */
  discardStroke(): void;
  /** Buttons 2+3: drop every hold and unwind whatever is in progress. */
  releaseAll(): void;
  modeChanged?(mode: RemoteMode): void;
}

interface ButtonState {
  downAt: number | null;
  /** Spent on a chord; its release must do nothing. */
  consumed: boolean;
  /** Passed the hold threshold, so release finalizes instead of tapping. */
  resolved: boolean;
}

const blank = (): ButtonState => ({ downAt: null, consumed: false, resolved: false });

/**
 * Gestures:
 * - 1 hold: draw / orbit / pan by mode; the drag grab during a push/pull.
 * - 1 tap: select under the cursor.  1 tap twice: undo.
 * - 2 tap: cycle the mode.
 * - 3 tap: `Tab` (work plane, or the active face during a push/pull).
 * - 3 hold: voice; release finalizes.
 * - 4 tap: `Q` to open a push/pull, again to apply.
 * - 4 hold: move; release applies.
 * - 2+4: fit the view.  2+3: release everything.
 */
export class RemoteSource {
  private readonly timings: RemoteTimings;
  private readonly state: Record<RemoteButton, ButtonState> = { 1: blank(), 2: blank(), 3: blank(), 4: blank() };
  private modeIndex = 0;
  /** The hold button 1 currently owns, if any. */
  private engaged: HoldAction | null = null;
  private lastTapAt: number | null = null;

  constructor(private readonly handlers: RemoteHandlers, timings: Partial<RemoteTimings> = {}) {
    this.timings = { ...DEFAULT_REMOTE_TIMINGS, ...timings };
  }

  get mode(): RemoteMode {
    return REMOTE_MODES[this.modeIndex];
  }

  get modeLabel(): string {
    return REMOTE_MODE_LABELS[this.mode];
  }

  /** True while button 1 holds a gesture open. */
  get gesturing(): boolean {
    return this.engaged !== null;
  }

  get voiceHeld(): boolean {
    return this.state[3].resolved;
  }

  get moveHeld(): boolean {
    return this.state[4].resolved;
  }

  down(button: RemoteButton, nowMs: number): void {
    const state = this.state[button];
    // A held HID key repeats; only the first keydown starts anything.
    if (state.downAt !== null) return;
    state.downAt = nowMs;
    state.consumed = false;
    state.resolved = false;
    if (this.detectChord(button, nowMs)) return;
    if (button === 1) {
      this.engaged = this.mode;
      this.handlers.hold(this.engaged, true);
    }
    // Button 2 acts on release so a chord can pre-empt it; 3 and 4 resolve in
    // tick() once they pass the hold threshold, or on release as a tap.
  }

  up(button: RemoteButton, nowMs: number): void {
    const state = this.state[button];
    if (state.downAt === null) return;
    const heldMs = nowMs - state.downAt;
    const { consumed, resolved } = state;
    this.state[button] = blank();
    if (consumed) return;
    switch (button) {
      case 1:
        this.releaseDrawButton(heldMs, nowMs);
        break;
      case 2:
        this.cycleMode();
        break;
      case 3:
        if (resolved) this.handlers.voice(false);
        else this.handlers.press('cyclePlane');
        break;
      case 4:
        if (resolved) this.handlers.move(false);
        else this.handlers.press('extrude');
        break;
    }
  }

  /** Call once per frame; resolves hold thresholds and expires the tap window. */
  tick(nowMs: number): void {
    this.resolveHold(3, nowMs, () => this.handlers.voice(true));
    this.resolveHold(4, nowMs, () => this.handlers.move(true));
    if (this.lastTapAt !== null && nowMs - this.lastTapAt > this.timings.doubleTapMs) this.lastTapAt = null;
  }

  /**
   * Forget every button without replaying its action.  Used on focus loss and
   * whenever the app unwinds on its own; anything still in flight is unwound
   * through `releaseAll` so the recognizer is never left listening.
   */
  reset(): void {
    const active = this.engaged !== null || this.state[3].resolved || this.state[4].resolved;
    for (const button of [1, 2, 3, 4] as const) this.state[button] = blank();
    this.engaged = null;
    this.lastTapAt = null;
    if (active) this.handlers.releaseAll();
  }

  private resolveHold(button: 3 | 4, nowMs: number, fire: () => void): void {
    const state = this.state[button];
    if (state.downAt === null || state.consumed || state.resolved) return;
    if (nowMs - state.downAt < this.timings.holdMs) return;
    state.resolved = true;
    fire();
  }

  /**
   * Button 2 is a modifier for as long as it is held, so 2-then-4 is always a
   * chord.  Pressed the other way round, 2+4 only counts while button 4 is
   * still inside `chordMs` — shorter than `holdMs`, so a fit never interrupts a
   * move that already started.
   *
   * 2+3 is exempt from both limits and takes precedence.  The moment you most
   * need to release everything is while something is already running, so the
   * safety gesture must fire even on a button 3 that has been recording for
   * seconds.
   */
  private detectChord(button: RemoteButton, nowMs: number): boolean {
    if (button === 3 || button === 4) {
      if (this.state[2].downAt === null || this.state[2].consumed) return false;
      this.fireChord(button);
      return true;
    }
    if (button !== 2) return false;
    const three = this.state[3];
    if (three.downAt !== null && !three.consumed) {
      this.fireChord(3);
      return true;
    }
    const four = this.state[4];
    if (four.downAt === null || four.consumed || four.resolved) return false;
    if (nowMs - four.downAt > this.timings.chordMs) return false;
    this.fireChord(4);
    return true;
  }

  private fireChord(other: 3 | 4): void {
    this.state[2].consumed = true;
    this.state[other].consumed = true;
    this.lastTapAt = null;
    if (other === 4) {
      this.handlers.press('fitAll');
      return;
    }
    // 2+3 is the safety gesture: spend every held button so nothing fires on
    // release, then let the app drop its holds and unwind.
    for (const button of [1, 3, 4] as const) {
      if (this.state[button].downAt !== null) this.state[button].consumed = true;
      this.state[button].resolved = false;
    }
    this.engaged = null;
    this.handlers.releaseAll();
  }

  /**
   * A tap has to be discarded before the hold is released, because releasing
   * `draw` commits the stroke and a hand-held tip drifts well past the
   * six-pixel threshold that would otherwise throw it away.  Taps only carry
   * select/undo in draw mode; in orbit and pan a tap is just a nudge.
   */
  private releaseDrawButton(heldMs: number, nowMs: number): void {
    const engaged = this.engaged;
    this.engaged = null;
    const tap = heldMs <= this.timings.tapMs && engaged === 'draw';
    if (tap) this.handlers.discardStroke();
    if (engaged) this.handlers.hold(engaged, false);
    if (!tap) {
      this.lastTapAt = null;
      return;
    }
    const previous = this.lastTapAt;
    if (previous !== null && nowMs - previous <= this.timings.doubleTapMs) {
      this.lastTapAt = null;
      this.handlers.press('undo');
      return;
    }
    this.lastTapAt = nowMs;
    this.handlers.press('select');
  }

  private cycleMode(): void {
    // Switching mid-gesture would end a stroke and open an orbit in one step.
    if (this.engaged) return;
    this.modeIndex = (this.modeIndex + 1) % REMOTE_MODES.length;
    this.handlers.modeChanged?.(this.mode);
  }
}
