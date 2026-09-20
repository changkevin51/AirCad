import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REMOTE_TIMINGS,
  REMOTE_MODE_LABELS,
  REMOTE_MODES,
  remoteButtonForCode,
  RemoteSource,
  type RemoteHandlers,
  type RemoteTimings,
} from './remote';

/** Ordered log of handler calls: ordering is load-bearing for taps. */
function harness(timings: Partial<RemoteTimings> = {}) {
  const log: string[] = [];
  const handlers: RemoteHandlers = {
    hold: (action, down) => log.push(`hold:${action}:${down ? 'down' : 'up'}`),
    press: (action) => log.push(`press:${action}`),
    voice: (down) => log.push(`voice:${down ? 'down' : 'up'}`),
    move: (down) => log.push(`move:${down ? 'down' : 'up'}`),
    discardStroke: () => log.push('discard'),
    releaseAll: () => log.push('releaseAll'),
    modeChanged: (mode) => log.push(`mode:${mode}`),
  };
  return { remote: new RemoteSource(handlers, timings), log };
}

const { holdMs, tapMs, doubleTapMs, chordMs } = DEFAULT_REMOTE_TIMINGS;
const LONG = Math.max(holdMs, tapMs) + 50;

describe('remote key codes', () => {
  it('claims F13-F16 and nothing else', () => {
    expect(remoteButtonForCode('F13')).toBe(1);
    expect(remoteButtonForCode('F14')).toBe(2);
    expect(remoteButtonForCode('F15')).toBe(3);
    expect(remoteButtonForCode('F16')).toBe(4);
    for (const code of ['Digit1', 'Digit4', 'Space', 'KeyQ', 'Tab', 'F1', 'F12', 'F17']) {
      expect(remoteButtonForCode(code)).toBeNull();
    }
  });
});

describe('RemoteSource modes', () => {
  it('starts in draw mode', () => {
    const { remote } = harness();
    expect(remote.mode).toBe('draw');
    expect(remote.modeLabel).toBe('Draw');
    expect(REMOTE_MODES).toEqual(['draw', 'orbit', 'pan']);
    expect(REMOTE_MODE_LABELS).toEqual({ draw: 'Draw', orbit: 'Orbit', pan: 'Pan' });
  });

  it('cycles draw to orbit to pan and back on button 2, reporting each change', () => {
    const { remote, log } = harness();
    for (const expected of ['orbit', 'pan', 'draw'] as const) {
      remote.down(2, 0);
      remote.up(2, 40);
      expect(remote.mode).toBe(expected);
    }
    expect(log).toEqual(['mode:orbit', 'mode:pan', 'mode:draw']);
  });

  it('engages the hold that matches the mode and releases the same one', () => {
    const { remote, log } = harness();
    for (const expected of ['draw', 'orbit', 'pan'] as const) {
      expect(remote.mode).toBe(expected);
      remote.down(1, 0);
      expect(remote.gesturing).toBe(true);
      remote.up(1, LONG);
      expect(remote.gesturing).toBe(false);
      remote.down(2, LONG);
      remote.up(2, LONG + 40);
    }
    expect(log.filter((entry) => entry.startsWith('hold:'))).toEqual([
      'hold:draw:down', 'hold:draw:up',
      'hold:orbit:down', 'hold:orbit:up',
      'hold:pan:down', 'hold:pan:up',
    ]);
  });

  it('refuses to switch mode mid-gesture', () => {
    const { remote, log } = harness();
    remote.down(1, 0);
    remote.down(2, 20);
    remote.up(2, 60);
    expect(remote.mode).toBe('draw');
    remote.up(1, LONG);
    // Free again once the gesture ends.
    remote.down(2, LONG + 10);
    remote.up(2, LONG + 50);
    expect(remote.mode).toBe('orbit');
    expect(log).toEqual(['hold:draw:down', 'hold:draw:up', 'mode:orbit']);
  });

  it('ignores the auto-repeat keydown of a held button', () => {
    const { remote, log } = harness();
    remote.down(1, 0);
    remote.down(1, 30);
    remote.down(1, 60);
    remote.up(1, LONG);
    expect(log).toEqual(['hold:draw:down', 'hold:draw:up']);
  });
});

describe('RemoteSource button 1', () => {
  it('discards the stroke before releasing the hold, then selects', () => {
    const { remote, log } = harness();
    remote.down(1, 0);
    remote.up(1, tapMs - 1);
    // Discarding after the release would have committed the tap as geometry.
    expect(log).toEqual(['hold:draw:down', 'discard', 'hold:draw:up', 'press:select']);
  });

  it('turns a second tap inside the window into undo instead of a second select', () => {
    const { remote, log } = harness();
    remote.down(1, 0);
    remote.up(1, 100);
    remote.down(1, 150);
    remote.up(1, 200);
    expect(log.filter((entry) => entry.startsWith('press:'))).toEqual(['press:select', 'press:undo']);
  });

  it('counts a gap of exactly the window as a double tap', () => {
    const { remote, log } = harness();
    remote.down(1, 0);
    remote.up(1, 100);
    remote.down(1, 100 + doubleTapMs - 20);
    remote.up(1, 100 + doubleTapMs);
    expect(log.filter((entry) => entry.startsWith('press:'))).toEqual(['press:select', 'press:undo']);
  });

  it('needs three taps for two undos, not a held second tap', () => {
    const { remote, log } = harness();
    remote.down(1, 0);
    remote.up(1, 60);
    remote.down(1, 100);
    remote.up(1, 160);
    remote.down(1, 200);
    remote.up(1, 260);
    expect(log.filter((entry) => entry.startsWith('press:'))).toEqual(['press:select', 'press:undo', 'press:select']);
  });

  it('treats taps beyond the window as two separate selects', () => {
    const { remote, log } = harness();
    remote.down(1, 0);
    remote.up(1, 100);
    remote.down(1, 500);
    remote.up(1, 560);
    expect(log.filter((entry) => entry.startsWith('press:'))).toEqual(['press:select', 'press:select']);
  });

  it('expires the tap window on tick so a much later tap still selects', () => {
    const { remote, log } = harness();
    remote.down(1, 0);
    remote.up(1, 100);
    remote.tick(100 + doubleTapMs + 1);
    remote.down(1, 500);
    remote.up(1, 540);
    expect(log.filter((entry) => entry.startsWith('press:'))).toEqual(['press:select', 'press:select']);
  });

  it('leaves a real gesture alone: no discard, no select, no undo', () => {
    const { remote, log } = harness();
    remote.down(1, 0);
    remote.up(1, tapMs + 1);
    expect(log).toEqual(['hold:draw:down', 'hold:draw:up']);
  });

  it('does not let a gesture arm the double-tap window', () => {
    const { remote, log } = harness();
    remote.down(1, 0);
    remote.up(1, 100);
    remote.down(1, 150);
    remote.up(1, 150 + LONG);
    remote.down(1, 400);
    remote.up(1, 450);
    expect(log.filter((entry) => entry.startsWith('press:'))).toEqual(['press:select', 'press:select']);
  });

  it('carries no select or undo outside draw mode', () => {
    const { remote, log } = harness();
    remote.down(2, 0);
    remote.up(2, 40);
    expect(remote.mode).toBe('orbit');
    remote.down(1, 100);
    remote.up(1, 150);
    remote.down(1, 200);
    remote.up(1, 250);
    expect(log).toEqual(['mode:orbit', 'hold:orbit:down', 'hold:orbit:up', 'hold:orbit:down', 'hold:orbit:up']);
  });
});

describe('RemoteSource buttons 3 and 4', () => {
  it('sends Tab on a short button 3 and never opens the recognizer', () => {
    const { remote, log } = harness();
    remote.down(3, 0);
    remote.tick(holdMs - 1);
    remote.up(3, holdMs - 1);
    expect(log).toEqual(['press:cyclePlane']);
    expect(remote.voiceHeld).toBe(false);
  });

  it('records for exactly as long as button 3 is held', () => {
    const { remote, log } = harness();
    remote.down(3, 0);
    remote.tick(holdMs);
    expect(remote.voiceHeld).toBe(true);
    remote.tick(holdMs + 100);
    remote.tick(holdMs + 200);
    remote.up(3, 900);
    expect(log).toEqual(['voice:down', 'voice:up']);
    expect(remote.voiceHeld).toBe(false);
  });

  it('opens a push/pull on a short button 4 and applies on the next one', () => {
    const { remote, log } = harness();
    for (let i = 0; i < 2; i++) {
      remote.down(4, i * 1000);
      remote.up(4, i * 1000 + 50);
    }
    expect(log).toEqual(['press:extrude', 'press:extrude']);
    expect(remote.moveHeld).toBe(false);
  });

  it('moves while button 4 is held and applies on release', () => {
    const { remote, log } = harness();
    remote.down(4, 0);
    remote.tick(holdMs);
    expect(remote.moveHeld).toBe(true);
    remote.tick(holdMs + 100);
    remote.up(4, 800);
    expect(log).toEqual(['move:down', 'move:up']);
  });
});

describe('RemoteSource chords', () => {
  it('fits the view for 2+4 and suppresses both solo actions', () => {
    const { remote, log } = harness();
    remote.down(2, 0);
    remote.down(4, 50);
    remote.tick(400);
    remote.up(4, 500);
    remote.up(2, 550);
    expect(log).toEqual(['press:fitAll']);
    expect(remote.mode).toBe('draw');
  });

  it('still chords when button 2 arrives just after button 4', () => {
    const { remote, log } = harness();
    remote.down(4, 0);
    remote.down(2, chordMs);
    remote.up(2, 300);
    remote.up(4, 350);
    expect(log).toEqual(['press:fitAll']);
    expect(remote.mode).toBe('draw');
  });

  it('is not a chord when button 2 arrives too late after button 4', () => {
    const { remote, log } = harness();
    remote.down(4, 0);
    remote.down(2, chordMs + 1);
    remote.up(4, chordMs + 20);
    remote.up(2, chordMs + 60);
    expect(log).toEqual(['press:extrude', 'mode:orbit']);
  });

  it('releases everything for 2+3 and spends a held button 1', () => {
    const { remote, log } = harness();
    remote.down(1, 0);
    remote.down(2, 50);
    remote.down(3, 80);
    expect(log).toEqual(['hold:draw:down', 'releaseAll']);
    expect(remote.gesturing).toBe(false);
    log.length = 0;
    remote.up(1, 200);
    remote.up(3, 240);
    remote.up(2, 280);
    expect(log).toEqual([]);
  });

  it('does not finalize a live recording when 2+3 unwinds it', () => {
    const { remote, log } = harness();
    remote.down(3, 0);
    remote.tick(holdMs);
    expect(remote.voiceHeld).toBe(true);
    remote.down(2, holdMs + 10);
    remote.up(3, holdMs + 200);
    remote.up(2, holdMs + 240);
    // voice:up would have committed whatever the recognizer had heard.
    expect(log).toEqual(['voice:down', 'releaseAll']);
    expect(remote.voiceHeld).toBe(false);
  });

  it('releases everything rather than fitting when both 3 and 4 are down', () => {
    const { remote, log } = harness();
    remote.down(4, 0);
    remote.down(3, 20);
    remote.down(2, 40);
    expect(log).toEqual(['releaseAll']);
  });

  it('keeps the mode when a chord consumes button 2', () => {
    const { remote } = harness();
    remote.down(2, 0);
    remote.down(3, 30);
    remote.up(3, 60);
    remote.up(2, 90);
    expect(remote.mode).toBe('draw');
  });
});

describe('RemoteSource reset', () => {
  it('unwinds an in-flight gesture and then fires nothing on the stale release', () => {
    const { remote, log } = harness();
    remote.down(1, 0);
    log.length = 0;
    remote.reset();
    expect(log).toEqual(['releaseAll']);
    expect(remote.gesturing).toBe(false);
    remote.up(1, 500);
    expect(log).toEqual(['releaseAll']);
  });

  it('unwinds a live recording and a live move', () => {
    for (const button of [3, 4] as const) {
      const { remote, log } = harness();
      remote.down(button, 0);
      remote.tick(holdMs);
      log.length = 0;
      remote.reset();
      expect(log).toEqual(['releaseAll']);
      expect(remote.voiceHeld).toBe(false);
      expect(remote.moveHeld).toBe(false);
    }
  });

  it('stays quiet when nothing was in flight', () => {
    const { remote, log } = harness();
    remote.down(2, 0);
    remote.reset();
    expect(log).toEqual([]);
  });

  it('keeps the chosen mode, since focus loss is not a mode change', () => {
    const { remote } = harness();
    remote.down(2, 0);
    remote.up(2, 40);
    remote.reset();
    expect(remote.mode).toBe('orbit');
  });
});

describe('RemoteSource timings', () => {
  it('honours overridden thresholds', () => {
    const { remote, log } = harness({ holdMs: 500, tapMs: 20 });
    remote.down(3, 0);
    remote.tick(499);
    expect(remote.voiceHeld).toBe(false);
    remote.tick(500);
    expect(remote.voiceHeld).toBe(true);
    remote.up(3, 600);
    log.length = 0;
    remote.down(1, 0);
    remote.up(1, 30);
    expect(log).toEqual(['hold:draw:down', 'hold:draw:up']);
  });

  it('resolves a chord before a hold can start', () => {
    expect(DEFAULT_REMOTE_TIMINGS.chordMs).toBeLessThan(DEFAULT_REMOTE_TIMINGS.holdMs);
  });
});
