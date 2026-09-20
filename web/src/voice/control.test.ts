import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Commands } from '../model/commands';
import { WorkPlane } from '../model/plane';
import { Sketch, type LineEntity } from '../model/sketch';
import type { SnapResult } from '../model/snap';
import { StrokeSession } from '../model/stroke';
import { add, v2, v3 } from '../model/vec';
import { captureVoiceTarget, dispatchVoiceCommand, sameVoiceTarget, type VoiceTarget } from './commands';
import { VoiceControl, type VoiceControlOptions } from './control';
import { UNSUPPORTED_SPEECH, type SpeechRecognitionEventLike, type SpeechRecognitionHandle, type SpeechRecognitionResultLike } from './speech';

const h = vi.hoisted(() => ({
  pagehide: null as null | (() => void),
}));

let current: FakeRecognition | null = null;

class FakeRecognition implements SpeechRecognitionHandle {
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  lang = '';
  onresult: ((event: SpeechRecognitionEventLike) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  startCount = 0;
  stopCount = 0;
  abortCount = 0;

  constructor() {
    current = this;
  }

  start(): void {
    this.startCount += 1;
  }

  stop(): void {
    this.stopCount += 1;
    this.onend?.();
  }

  abort(): void {
    this.abortCount += 1;
    this.onerror?.({ error: 'aborted' });
    this.onend?.();
  }

  emit(isFinal: boolean, ...transcripts: string[]): void {
    const result = { isFinal, length: transcripts.length } as SpeechRecognitionResultLike;
    transcripts.forEach((transcript, index) => {
      result[index] = { transcript };
    });
    this.onresult?.({ resultIndex: 0, results: [result] });
  }
}

class FakeEl {
  className = '';
  textContent = '';
  type = '';
  disabled = false;
  hidden = false;
  blurCount = 0;
  readonly children: FakeEl[] = [];
  readonly attrs = new Map<string, string>();
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  appendChild(child: FakeEl): FakeEl {
    this.children.push(child);
    return child;
  }
  append(...children: FakeEl[]): void {
    this.children.push(...children);
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener));
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  blur(): void {
    this.blurCount += 1;
  }
  click(): void {
    for (const listener of this.listeners.get('click') ?? []) listener({ stopPropagation: () => {} });
  }
  fire(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const find = (el: FakeEl, className: string): FakeEl => {
  if (el.className === className) return el;
  for (const child of el.children) {
    try {
      return find(child, className);
    } catch {
      continue;
    }
  }
  throw new Error(`missing .${className}`);
};

const ORIGIN = v3(100, 200, 300);
const IDLE_STATUS = 'Start a line or pull a face, then press V while holding. Say “500 mm” or “by 1 m”. Units apply immediately; V confirms a bare number.';

const snapOn = (plane: WorkPlane, world: ReturnType<typeof v3>): SnapResult => ({
  type: 'free',
  world,
  plane: plane.toPlane(world),
  screen: plane.toPlane(world),
  onPlane: true,
  raw: world,
});

function drawStroke(): StrokeSession {
  const plane = new WorkPlane('XY', ORIGIN);
  const session = new StrokeSession(plane, snapOn(plane, ORIGIN));
  const end = add(ORIGIN, v3(30, 40, 0));
  session.add(snapOn(plane, end), end, v2(130, 240), 0);
  return session;
}

describe('VoiceControl', () => {
  let sketch: Sketch;
  let commands: Commands;
  let stroke: StrokeSession | null;
  let captured: VoiceTarget | null;
  let stale: boolean;
  let ready: boolean;
  let notify: (message: string, error: boolean) => void;
  let root: FakeEl;
  let recordButton: FakeEl;
  let cancelButton: FakeEl;
  let statusEl: FakeEl;
  let control: VoiceControl;
  let captureSpy: ReturnType<typeof vi.fn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const line = (): LineEntity | null => {
    const last = sketch.last;
    return last?.type === 'line' ? last : null;
  };

  const rec = (): FakeRecognition => {
    if (!current) throw new Error('expected speech recognition to start');
    return current;
  };

  beforeEach(() => {
    sketch = new Sketch();
    commands = new Commands(sketch);
    stroke = drawStroke();
    captured = null;
    stale = false;
    ready = true;
    current = null;
    notify = vi.fn();
    h.pagehide = null;
    vi.stubGlobal('document', { createElement: () => new FakeEl() });
    vi.stubGlobal('window', { addEventListener: (type: string, listener: () => void) => { if (type === 'pagehide') h.pagehide = listener; } });
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    captureSpy = vi.fn(() => {
      captured = captureVoiceTarget(stroke, null, ready);
      return captured;
    });
    const options: VoiceControlOptions = {
      capture: captureSpy as unknown as () => VoiceTarget,
      isCurrent: (target) => {
        if (stale || captured !== target) return false;
        try {
          return sameVoiceTarget(target, captureVoiceTarget(stroke, null, ready));
        } catch {
          return false;
        }
      },
      execute: (command, target) => {
        let currentTarget: VoiceTarget | null = null;
        try {
          currentTarget = captureVoiceTarget(stroke, null, ready);
        } catch {
          currentTarget = null;
        }
        const result = dispatchVoiceCommand(command, target, commands, currentTarget);
        if (result.ok) {
          stroke = null;
          captured = null;
        }
        return result;
      },
      notify,
      speechRecognition: FakeRecognition,
    };
    root = new FakeEl();
    control = new VoiceControl(root as unknown as HTMLElement, options);
    recordButton = find(root, 'voice-control__record');
    cancelButton = find(root, 'voice-control__cancel');
    statusEl = find(root, 'voice-control__status');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('renders the idle panel', () => {
    expect(recordButton.type).toBe('button');
    expect(recordButton.textContent).toBe('Speak distance');
    expect(cancelButton.hidden).toBe(true);
    expect(statusEl.textContent).toBe(IDLE_STATUS);
    expect(statusEl.attrs.get('role')).toBe('status');
    expect(statusEl.attrs.get('aria-live')).toBe('polite');
  });

  it('captures the operation before starting speech recognition', async () => {
    const pending = control.listen();
    await flush();
    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(current).not.toBeNull();
    rec().emit(false, '500 mm');
    await pending;
    expect(line()!.b).toEqual(v3(400, 600, 300));
  });

  it('auto-commits an interim transcript that includes units', async () => {
    const pending = control.listen();
    await flush();
    rec().emit(false, '500 millimetres');
    await pending;
    expect(line()!.b).toEqual(v3(400, 600, 300));
    expect(statusEl.textContent).toBe('Heard: 500 millimetres\nCreated 500 mm line on XY');
    expect(notify).toHaveBeenCalledWith('Created 500 mm line on XY', false);
    expect(infoSpy).toHaveBeenCalledWith('[voice] transcript', '500 millimetres');
    expect(infoSpy).toHaveBeenCalledWith('[voice] executed', expect.objectContaining({ kind: 'line' }));
    expect(recordButton.textContent).toBe('Speak distance');
    expect(cancelButton.hidden).toBe(true);
  });

  it('commits only once even if a final result follows the interim match', async () => {
    const pending = control.listen();
    await flush();
    rec().emit(false, '500 mm');
    rec().emit(true, '500 mm');
    await pending;
    expect(sketch.all.filter((entity) => entity.type === 'line')).toHaveLength(1);
  });

  it('uses a later alternative when the first transcript is not a measurement', async () => {
    const pending = control.listen();
    await flush();
    rec().emit(false, 'about 500', '500 mm');
    await pending;
    expect(line()!.b).toEqual(v3(400, 600, 300));
  });

  it('keeps a bare number open until V confirms it', async () => {
    const pending = control.listen();
    await flush();
    rec().emit(false, '500');
    await flush();
    expect(line()).toBeNull();
    expect(statusEl.textContent).toContain('Heard: 500');
    control.toggle();
    await pending;
    expect(line()!.b).toEqual(v3(400, 600, 300));
  });

  it('commits a bare number when the recognizer marks the result final', async () => {
    const pending = control.listen();
    await flush();
    rec().emit(true, '500');
    await pending;
    expect(line()!.b).toEqual(v3(400, 600, 300));
  });

  it('never starts speech without an eligible operation', async () => {
    stroke = null;
    await control.listen();
    expect(current).toBeNull();
    expect(notify).toHaveBeenCalledWith('Voice command failed; see the voice panel', true);

    stroke = drawStroke();
    const plane = new WorkPlane('XY', ORIGIN);
    stroke = new StrokeSession(plane, snapOn(plane, ORIGIN));
    await control.listen();
    expect(current).toBeNull();
    expect(line()).toBeNull();
  });

  it('fails immediately when the browser has no speech recognition', async () => {
    const options: VoiceControlOptions = {
      capture: captureSpy as unknown as () => VoiceTarget,
      isCurrent: () => true,
      execute: () => ({ ok: false, error: 'unused' }),
      notify,
      speechRecognition: null,
    };
    const unsupported = new VoiceControl(new FakeEl() as unknown as HTMLElement, options);
    await unsupported.listen();
    expect(captureSpy).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('Voice command failed; see the voice panel', true);
  });

  it('reports the unsupported-browser message', async () => {
    const status = find(
      (() => {
        const host = new FakeEl();
        const options: VoiceControlOptions = {
          capture: captureSpy as unknown as () => VoiceTarget,
          isCurrent: () => true,
          execute: () => ({ ok: false, error: 'unused' }),
          notify,
          speechRecognition: null,
        };
        new VoiceControl(host as unknown as HTMLElement, options).listen();
        return host;
      })(),
      'voice-control__status',
    );
    await flush();
    expect(status.textContent).toContain(UNSUPPORTED_SPEECH);
  });

  it('ignores a second listen while one session is in progress', async () => {
    const first = control.listen();
    await flush();
    expect(recordButton.textContent).toBe('Confirm number');
    expect(statusEl.textContent).toContain('Listening…');
    expect(statusEl.textContent).toContain('Line · XY');
    await control.listen();
    expect(rec().startCount).toBe(1);
    rec().emit(false, '500 mm');
    await first;
    expect(line()!.b).toEqual(v3(400, 600, 300));
  });

  it('toggle() starts listening when idle and confirms while listening', async () => {
    control.toggle();
    await flush();
    expect(rec().startCount).toBe(1);
    rec().emit(false, 'by 1 m');
    await flush();
    expect(line()!.b).toEqual(v3(700, 1000, 300));
  });

  it('routes the record button through toggle()', async () => {
    recordButton.click();
    await flush();
    expect(rec().startCount).toBe(1);
    rec().emit(false, '500 mm');
    await flush();
    expect(line()).not.toBeNull();
  });

  it('rejects a confirm with no usable transcript', async () => {
    const pending = control.listen();
    await flush();
    control.stop();
    await pending;
    expect(statusEl.textContent).toContain('Say one positive distance, such as 500 mm or by 1 m');
    expect(line()).toBeNull();
    expect(notify).toHaveBeenCalledWith('Voice command failed; see the voice panel', true);
    expect(errorSpy).toHaveBeenCalledWith('[voice] error', 'Say one positive distance, such as 500 mm or by 1 m');
  });

  it('rejects a non-measurement transcript on confirm', async () => {
    const pending = control.listen();
    await flush();
    rec().emit(false, 'make it 500 mm tall');
    control.stop();
    await pending;
    expect(statusEl.textContent).toContain('Say one positive distance');
    expect(line()).toBeNull();
  });

  it('surfaces permission errors and never executes', async () => {
    const pending = control.listen();
    await flush();
    rec().onerror?.({ error: 'not-allowed' });
    await pending;
    expect(statusEl.textContent).toContain('Microphone permission was denied');
    expect(line()).toBeNull();
    expect(notify).toHaveBeenCalledWith('Voice command failed; see the voice panel', true);
  });

  it('does not execute when the operation goes stale before a match', async () => {
    const pending = control.listen();
    await flush();
    stale = true;
    rec().emit(false, '500 mm');
    await pending;
    expect(statusEl.textContent).toContain('Operation or geometry changed');
    expect(line()).toBeNull();
  });

  it('reports cancellation and restores idle', async () => {
    const pending = control.listen();
    await flush();
    control.cancel();
    expect(statusEl.textContent).toBe('Cancelling voice request… dismiss the microphone permission prompt if it is still open.');
    expect(recordButton.disabled).toBe(true);
    expect(cancelButton.disabled).toBe(true);
    await pending;
    expect(statusEl.textContent).toContain('Voice request cancelled');
    expect(line()).toBeNull();
    expect(recordButton.textContent).toBe('Speak distance');
    expect(recordButton.disabled).toBe(false);
  });

  it('does not execute a late result after cancel', async () => {
    const pending = control.listen();
    await flush();
    const recognition = rec();
    control.cancel();
    recognition.emit(false, '500 mm');
    await pending;
    expect(line()).toBeNull();
    expect(recordButton.textContent).toBe('Speak distance');
  });

  it('stops listening from the public stop() and the record button', async () => {
    const pending = control.listen();
    await flush();
    rec().emit(false, '500');
    control.stop();
    await pending;
    expect(line()!.b).toEqual(v3(400, 600, 300));
  });

  it('keeps panel keystrokes away from the CAD keymap and cancels on pagehide', async () => {
    const pending = control.listen();
    await flush();
    const stop = vi.fn();
    root.children[0].fire('keydown', { stopPropagation: stop });
    root.children[0].fire('keyup', { stopPropagation: stop });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(h.pagehide).not.toBeNull();
    h.pagehide!();
    await pending;
    expect(statusEl.textContent).toContain('Voice request cancelled');
  });
});
