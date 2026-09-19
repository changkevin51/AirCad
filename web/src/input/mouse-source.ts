import { v2, type Vec2 } from '../model/vec';
import type { HoldAction } from './keymap';

export interface MouseSourceHandlers {
  onMove(point: Vec2): void;
  onHold(action: Extract<HoldAction, 'draw' | 'orbit' | 'pan'>, down: boolean): void;
  onWheel(deltaY: number, point: Vec2): void;
}

const BUTTON_ACTIONS: Record<number, Extract<HoldAction, 'draw' | 'orbit' | 'pan'>> = {
  0: 'draw',
  1: 'pan',
  2: 'orbit',
};

/**
 * Mouse fallback: moves the cursor when no hand is tracked and maps the
 * buttons onto the same hold actions as the pen keys.
 */
export class MouseSource {
  private readonly held = new Map<number, Extract<HoldAction, 'draw' | 'orbit' | 'pan'>>();
  private readonly abort = new AbortController();

  constructor(
    private readonly element: HTMLElement,
    private readonly handlers: MouseSourceHandlers,
  ) {
    const { signal } = this.abort;
    element.addEventListener('pointermove', (event) => this.handlers.onMove(this.localPoint(event)), { signal });
    element.addEventListener(
      'pointerdown',
      (event) => {
        const action = BUTTON_ACTIONS[event.button];
        if (!action) return;
        event.preventDefault();
        element.setPointerCapture(event.pointerId);
        this.handlers.onMove(this.localPoint(event));
        this.held.set(event.button, action);
        this.handlers.onHold(action, true);
      },
      { signal },
    );
    const release = (event: PointerEvent) => {
      const action = this.held.get(event.button);
      if (!action) return;
      this.held.delete(event.button);
      this.handlers.onHold(action, false);
    };
    element.addEventListener('pointerup', release, { signal });
    element.addEventListener('pointercancel', release, { signal });
    element.addEventListener('contextmenu', (event) => event.preventDefault(), { signal });
    element.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        this.handlers.onWheel(event.deltaY, this.localPoint(event));
      },
      { signal, passive: false },
    );
  }

  private localPoint(event: MouseEvent): Vec2 {
    const rect = this.element.getBoundingClientRect();
    return v2(event.clientX - rect.left, event.clientY - rect.top);
  }

  /** Release any held buttons (e.g. when the window loses focus). */
  releaseAll(): void {
    for (const action of this.held.values()) this.handlers.onHold(action, false);
    this.held.clear();
  }

  dispose(): void {
    this.abort.abort();
  }
}
