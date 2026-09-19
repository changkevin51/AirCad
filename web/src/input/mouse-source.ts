import type { HoldAction } from './keymap';
import { v2, type Vec2 } from '../model/vec';

export interface MouseSourceHandlers {
  onMove(point: Vec2): void;
  onHold(action: Extract<HoldAction, 'draw' | 'orbit' | 'pan'>, down: boolean): void;
  onWheel(factor: number, point: Vec2): void;
  onCancel(): void;
}

const BUTTON_ACTIONS: Partial<Record<number, Extract<HoldAction, 'draw' | 'orbit' | 'pan'>>> = {
  0: 'draw',
  1: 'pan',
  2: 'orbit',
};

export function wheelZoomFactor(deltaY: number, deltaMode: number, pageHeight: number): number {
  const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? pageHeight : 1);
  if (!Number.isFinite(pixels) || pixels === 0) return 1;
  return Math.exp(-Math.max(-100, Math.min(100, pixels)) * 0.0015);
}

/**
 * Mouse fallback: moves the cursor when no hand is tracked and maps the
 * buttons onto the same hold actions as the pen keys.
 */
export class MouseSource {
  private readonly abort = new AbortController();
  private readonly held = new Map<number, { action: Extract<HoldAction, 'draw' | 'orbit' | 'pan'> }>();

  constructor(
    private readonly element: HTMLElement,
    private readonly handlers: MouseSourceHandlers,
  ) {
    const { signal } = this.abort;

    element.addEventListener('pointerdown', (event) => {
      const action = BUTTON_ACTIONS[event.button];
      if (!action) return;
      event.preventDefault();
      element.setPointerCapture(event.pointerId);
      this.handlers.onMove(this.localPoint(event));
      this.held.set(event.pointerId, { action });
      this.handlers.onHold(action, true);
    }, { signal });

    element.addEventListener('pointermove', (event) => {
      this.handlers.onMove(this.localPoint(event));
    }, { signal });

    element.addEventListener('pointerup', (event) => {
      const entry = this.held.get(event.pointerId);
      if (!entry) return;
      this.handlers.onMove(this.localPoint(event));
      this.held.delete(event.pointerId);
      this.handlers.onHold(entry.action, false);
    }, { signal });

    const cancel = (event: PointerEvent) => {
      const entry = this.held.get(event.pointerId);
      if (!entry) return;
      this.held.delete(event.pointerId);
      this.handlers.onCancel();
    };
    element.addEventListener('pointercancel', cancel, { signal });
    element.addEventListener('lostpointercapture', cancel, { signal });

    element.addEventListener('wheel', (event) => {
      event.preventDefault();
      const factor = wheelZoomFactor(event.deltaY, event.deltaMode, element.clientHeight);
      if (factor !== 1) this.handlers.onWheel(factor, this.localPoint(event));
    }, { signal, passive: false });

    element.addEventListener('contextmenu', (event) => {
      event.preventDefault();
    }, { signal });
  }

  /** Release any held buttons (e.g. when the window loses focus). */
  releaseAll(notify = true): void {
    const wasActive = this.held.size > 0;
    this.held.clear();
    if (notify && wasActive) this.handlers.onCancel();
  }

  dispose(): void {
    this.abort.abort();
    this.held.clear();
  }

  private localPoint(event: PointerEvent | WheelEvent): Vec2 {
    const rect = this.element.getBoundingClientRect();
    return v2(event.clientX - rect.left, event.clientY - rect.top);
  }
}
