import { describe, expect, it, vi } from 'vitest';
import { MouseSource, wheelZoomFactor, type MouseSourceHandlers } from './mouse-source';

type Listener = (event: Record<string, unknown>) => void;

function fakeElement() {
  const listeners = new Map<string, Listener[]>();
  return {
    clientHeight: 600,
    addEventListener(type: string, listener: Listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    setPointerCapture() {},
    getBoundingClientRect() {
      return { left: 10, top: 20, width: 800, height: 600 };
    },
    dispatch(type: string, event: Record<string, unknown>) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
}

function fakeHandlers(): MouseSourceHandlers & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    onMove: vi.fn((point) => {
      calls.push(`move:${point.x},${point.y}`);
    }),
    onHold: vi.fn((action, down) => {
      calls.push(`hold:${action}:${down}`);
    }),
    onWheel: vi.fn((factor) => {
      calls.push(`wheel:${factor.toFixed(4)}`);
    }),
    onCancel: vi.fn(() => {
      calls.push('cancel');
    }),
  };
}

const pointer = (over: Record<string, unknown> = {}) => ({
  pointerId: 7,
  button: 0,
  clientX: 100,
  clientY: 200,
  preventDefault() {},
  ...over,
});

describe('wheelZoomFactor', () => {
  it('converts pixel, line and page deltas into a zoom factor', () => {
    expect(wheelZoomFactor(-120, 0, 600)).toBeCloseTo(Math.exp(0.15), 6);
    expect(wheelZoomFactor(-3, 1, 600)).toBeCloseTo(Math.exp(0.072), 6);
    expect(wheelZoomFactor(-1, 2, 600)).toBeCloseTo(Math.exp(0.15), 6);
    expect(wheelZoomFactor(120, 0, 600)).toBeCloseTo(Math.exp(-0.15), 6);
  });

  it('returns 1 for zero or non-finite deltas and clamps extremes', () => {
    expect(wheelZoomFactor(0, 0, 600)).toBe(1);
    expect(wheelZoomFactor(NaN, 0, 600)).toBe(1);
    expect(wheelZoomFactor(-1e9, 0, 600)).toBeCloseTo(Math.exp(0.15), 6);
  });
});

describe('MouseSource', () => {
  it('emits the down position before the hold and the final position before release', () => {
    const element = fakeElement();
    const handlers = fakeHandlers();
    new MouseSource(element as unknown as HTMLElement, handlers);
    element.dispatch('pointerdown', pointer());
    element.dispatch('pointermove', pointer({ clientX: 140, clientY: 240 }));
    element.dispatch('pointerup', pointer({ clientX: 160, clientY: 260 }));
    expect(handlers.calls).toEqual(['move:90,180', 'hold:draw:true', 'move:130,220', 'move:150,240', 'hold:draw:false']);
    expect(handlers.onCancel).not.toHaveBeenCalled();
  });

  it('cancels via pointercancel even when the button is -1', () => {
    const element = fakeElement();
    const handlers = fakeHandlers();
    new MouseSource(element as unknown as HTMLElement, handlers);
    element.dispatch('pointerdown', pointer());
    element.dispatch('pointercancel', pointer({ button: -1 }));
    expect(handlers.calls).toEqual(['move:90,180', 'hold:draw:true', 'cancel']);
    expect(handlers.onHold).toHaveBeenCalledTimes(1);
  });

  it('ignores a lost capture that arrives after a normal release', () => {
    const element = fakeElement();
    const handlers = fakeHandlers();
    new MouseSource(element as unknown as HTMLElement, handlers);
    element.dispatch('pointerdown', pointer());
    element.dispatch('pointerup', pointer());
    element.dispatch('lostpointercapture', pointer());
    expect(handlers.onCancel).not.toHaveBeenCalled();
    expect(handlers.calls).toEqual(['move:90,180', 'hold:draw:true', 'move:90,180', 'hold:draw:false']);
  });

  it('ignores a pointercancel from an unrelated pointer', () => {
    const element = fakeElement();
    const handlers = fakeHandlers();
    new MouseSource(element as unknown as HTMLElement, handlers);
    element.dispatch('pointerdown', pointer());
    element.dispatch('pointercancel', pointer({ pointerId: 99, button: -1 }));
    expect(handlers.onCancel).not.toHaveBeenCalled();
    element.dispatch('pointerup', pointer());
    expect(handlers.calls[handlers.calls.length - 1]).toBe('hold:draw:false');
  });

  it('reports wheel factors only when they differ from 1', () => {
    const element = fakeElement();
    const handlers = fakeHandlers();
    new MouseSource(element as unknown as HTMLElement, handlers);
    const wheel = (over: Record<string, unknown>) =>
      element.dispatch('wheel', { deltaY: 0, deltaMode: 0, clientX: 50, clientY: 60, preventDefault() {}, ...over });
    wheel({});
    wheel({ deltaY: -120 });
    wheel({ deltaY: -3, deltaMode: 1 });
    wheel({ deltaY: Number.NaN });
    expect(handlers.onWheel).toHaveBeenCalledTimes(2);
    expect(handlers.onWheel).toHaveBeenNthCalledWith(1, Math.exp(0.15), { x: 40, y: 40 });
    expect(handlers.onWheel).toHaveBeenNthCalledWith(2, Math.exp(0.072), { x: 40, y: 40 });
  });

  it('clears held pointers through releaseAll and notifies once', () => {
    const element = fakeElement();
    const handlers = fakeHandlers();
    const source = new MouseSource(element as unknown as HTMLElement, handlers);
    element.dispatch('pointerdown', pointer());
    source.releaseAll();
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    element.dispatch('pointerup', pointer());
    expect(handlers.onHold).toHaveBeenCalledTimes(1);
    source.releaseAll(false);
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    source.releaseAll();
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });
});
