import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Commands } from '../model/commands';
import { WorkPlane } from '../model/plane';
import { Sketch, type LineEntity } from '../model/sketch';
import type { SnapResult } from '../model/snap';
import { StrokeSession } from '../model/stroke';
import { add, v2, v3 } from '../model/vec';
import { captureVoiceTarget, dispatchVoiceCommand, sameVoiceTarget, type VoiceTarget } from './commands';
import { VoiceControl, type VoiceControlOptions } from './control';
import { recordMicrophone } from './microphone';

const h = vi.hoisted(() => ({
  recording: null as null | { audio: Promise<Blob>; stop(): void; cancel(): void },
  pagehide: null as null | (() => void),
}));

vi.mock('./microphone', () => ({
  audioBase64: vi.fn(async () => 'QUJD'),
  recordMicrophone: vi.fn(async (signal: AbortSignal) => {
    signal?.addEventListener('abort', () => h.recording?.cancel());
    return h.recording;
  }),
}));

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
const TRANSCRIPT = '500 millimetres';
const envelope = (command: unknown = { distance_mm: 500 }) => ({
  ok: true, transcript: TRANSCRIPT, command, response_text: JSON.stringify({ transcript: TRANSCRIPT, command, error: null }), call_id: 'call-1',
});
const respond = (body: unknown, init: { ok?: boolean; status?: number } = {}) => ({
  ok: init.ok ?? true,
  status: init.status ?? 200,
  json: async () => body,
});
const wavBlob = (): Blob => new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });

const snapOn = (plane: WorkPlane, world: ReturnType<typeof v3>): SnapResult => ({
  type: 'free',
  world,
  plane: plane.toPlane(world),
  screen: plane.toPlane(world),
  onPlane: true,
  raw: world,
});

/** A stroke on XY with a 50 mm (50 px) move along (0.6, 0.8, 0). */
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
  const fetchMock = vi.fn();

  const line = (): LineEntity | null => {
    const last = sketch.last;
    return last?.type === 'line' ? last : null;
  };

  beforeEach(() => {
    sketch = new Sketch();
    commands = new Commands(sketch);
    stroke = drawStroke();
    captured = null;
    stale = false;
    ready = true;
    notify = vi.fn();
    h.recording = null;
    h.pagehide = null;
    fetchMock.mockReset();
    vi.mocked(recordMicrophone).mockReset().mockImplementation(async (signal: AbortSignal) => {
      signal?.addEventListener('abort', () => h.recording?.cancel());
      return h.recording!;
    });
    vi.stubGlobal('document', { createElement: () => new FakeEl() });
    vi.stubGlobal('window', { addEventListener: (type: string, listener: () => void) => { if (type === 'pagehide') h.pagehide = listener; } });
    vi.stubGlobal('fetch', fetchMock);
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
        let current: VoiceTarget | null = null;
        try {
          current = captureVoiceTarget(stroke, null, ready);
        } catch {
          current = null;
        }
        const result = dispatchVoiceCommand(command, target, commands, current);
        if (result.ok) {
          stroke = null;
          captured = null;
        }
        return result;
      },
      notify,
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
    expect(recordButton.textContent).toBe('Record distance');
    expect(cancelButton.hidden).toBe(true);
    expect(statusEl.textContent).toBe('Start a line or pull a face, then press V while holding. Say “500 mm” or “by 1 m”. V again stops and sends (max 10 s).');
    expect(statusEl.attrs.get('role')).toBe('status');
    expect(statusEl.attrs.get('aria-live')).toBe('polite');
  });

  it('runs the full mocked flow: record, upload and create the measured line', async () => {
    h.recording = { audio: Promise.resolve(wavBlob()), stop: vi.fn(), cancel: vi.fn() };
    fetchMock.mockResolvedValue(respond(envelope()));
    await control.record();

    const created = line();
    expect(created).not.toBeNull();
    expect(created!.a).toEqual(ORIGIN);
    expect(created!.b).toEqual(v3(400, 500, 300));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/voice/command');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    const sent = JSON.parse(init.body as string);
    expect(sent.audio_wav_base64).toBe('QUJD');
    expect(sent.context).toEqual({ operation: 'line', units: 'mm' });
    expect(statusEl.textContent).toBe(`Heard: ${TRANSCRIPT}\nCreated 500 mm line on XY`);
    expect(notify).toHaveBeenCalledWith('Created 500 mm line on XY', false);
    expect(infoSpy).toHaveBeenCalledWith('[voice] API response', expect.any(String));
    expect(infoSpy).toHaveBeenCalledWith('[voice] transcript', TRANSCRIPT);
    expect(infoSpy).toHaveBeenCalledWith('[voice] executed', expect.objectContaining({ kind: 'line' }));
    expect(recordButton.textContent).toBe('Record distance');
    expect(recordButton.disabled).toBe(false);
    expect(cancelButton.hidden).toBe(true);
  });

  it('captures the operation synchronously before awaiting the microphone', async () => {
    h.recording = { audio: Promise.resolve(wavBlob()), stop: vi.fn(), cancel: vi.fn() };
    fetchMock.mockResolvedValue(respond(envelope()));
    await control.record();
    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(captureSpy.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(recordMicrophone).mock.invocationCallOrder[0]);
  });

  it('never opens the microphone or the network without an eligible operation', async () => {
    stroke = null;
    await control.record();
    expect(vi.mocked(recordMicrophone)).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('Voice command failed; see the voice panel', true);

    stroke = drawStroke();
    const plane = new WorkPlane('XY', ORIGIN);
    stroke = new StrokeSession(plane, snapOn(plane, ORIGIN));
    await control.record();
    expect(vi.mocked(recordMicrophone)).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(line()).toBeNull();
  });

  it('ignores a second record while one flight is in progress', async () => {
    let resolveAudio: (blob: Blob) => void = () => {};
    h.recording = { audio: new Promise<Blob>((resolve) => { resolveAudio = resolve; }), stop: vi.fn(), cancel: vi.fn() };
    fetchMock.mockResolvedValue(respond(envelope()));
    const first = control.record();
    await flush();
    expect(recordButton.textContent).toBe('Stop and send');
    expect(statusEl.textContent).toContain('Recording…');
    expect(statusEl.textContent).toContain('Line · XY');
    await control.record();
    expect(vi.mocked(recordMicrophone).mock.calls).toHaveLength(1);
    resolveAudio(wavBlob());
    await first;
    expect(line()!.b).toEqual(v3(400, 500, 300));
  });

  it('toggle() starts recording when idle and stops while recording', async () => {
    let resolveAudio: (blob: Blob) => void = () => {};
    h.recording = { audio: new Promise<Blob>((resolve) => { resolveAudio = resolve; }), stop: vi.fn(), cancel: vi.fn() };
    fetchMock.mockResolvedValue(respond(envelope()));
    control.toggle();
    await flush();
    expect(vi.mocked(recordMicrophone).mock.calls).toHaveLength(1);
    control.toggle();
    expect(h.recording.stop).toHaveBeenCalledTimes(1);
    resolveAudio(wavBlob());
    await flush();
    await flush();
    expect(line()!.b).toEqual(v3(400, 500, 300));
  });

  it('routes the record button through toggle()', async () => {
    h.recording = { audio: Promise.resolve(wavBlob()), stop: vi.fn(), cancel: vi.fn() };
    fetchMock.mockResolvedValue(respond(envelope()));
    recordButton.click();
    await flush();
    expect(vi.mocked(recordMicrophone).mock.calls).toHaveLength(1);
  });

  it('rejects an unsupported model command before execution', async () => {
    h.recording = { audio: Promise.resolve(wavBlob()), stop: vi.fn(), cancel: vi.fn() };
    fetchMock.mockResolvedValue(respond(envelope({ distance_mm: -50 })));
    await control.record();
    expect(statusEl.textContent).toContain('Say one positive distance, such as 500 mm or by 1 m');
    expect(line()).toBeNull();
    expect(notify).toHaveBeenCalledWith('Voice command failed; see the voice panel', true);
    expect(errorSpy).toHaveBeenCalledWith('[voice] error', 'Say one positive distance, such as 500 mm or by 1 m');
  });

  it('rejects a legacy axis command before execution', async () => {
    h.recording = { audio: Promise.resolve(wavBlob()), stop: vi.fn(), cancel: vi.fn() };
    fetchMock.mockResolvedValue(respond(envelope({ action: 'resize', target: 'current_object', axis: 'z', mode: 'delta', value_mm: 50 })));
    await control.record();
    expect(statusEl.textContent).toContain('Say one positive distance');
    expect(line()).toBeNull();
  });

  it('surfaces API errors, logs the raw response text and never executes', async () => {
    h.recording = { audio: Promise.resolve(wavBlob()), stop: vi.fn(), cancel: vi.fn() };
    fetchMock.mockResolvedValue(respond({ ok: false, error: 'Yibu returned HTTP 500', response_text: 'provider error body', call_id: 'c9' }));
    await control.record();
    expect(statusEl.textContent).toContain('Yibu returned HTTP 500');
    expect(infoSpy).toHaveBeenCalledWith('[voice] API response', 'provider error body');
    expect(line()).toBeNull();
    expect(notify).toHaveBeenCalledWith('Voice command failed; see the voice panel', true);
  });

  it('prevents the fetch when the operation goes stale during recording', async () => {
    let resolveAudio: (blob: Blob) => void = () => {};
    h.recording = { audio: new Promise<Blob>((resolve) => { resolveAudio = resolve; }), stop: vi.fn(), cancel: vi.fn() };
    const first = control.record();
    await flush();
    stale = true;
    resolveAudio(wavBlob());
    await first;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(statusEl.textContent).toContain('Operation or geometry changed');
    expect(line()).toBeNull();
  });

  it('rejects execution when the operation goes stale while the API call is pending', async () => {
    h.recording = { audio: Promise.resolve(wavBlob()), stop: vi.fn(), cancel: vi.fn() };
    let resolveFetch: (value: unknown) => void = () => {};
    fetchMock.mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const first = control.record();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stale = true;
    resolveFetch(respond(envelope()));
    await first;
    expect(statusEl.textContent).toContain('Operation or geometry changed');
    expect(line()).toBeNull();
  });

  it('reports cancellation when the in-flight fetch rejects on abort', async () => {
    h.recording = { audio: Promise.resolve(wavBlob()), stop: vi.fn(), cancel: vi.fn() };
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('The user aborted a request.', 'AbortError')));
    }));
    const first = control.record();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    control.cancel();
    await first;
    expect(statusEl.textContent).toContain('Voice request cancelled');
    expect(line()).toBeNull();
    expect(recordButton.textContent).toBe('Record distance');
  });

  it('ignores a late successful response that resolves after cancel', async () => {
    h.recording = { audio: Promise.resolve(wavBlob()), stop: vi.fn(), cancel: vi.fn() };
    let resolveFetch: (value: unknown) => void = () => {};
    fetchMock.mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const first = control.record();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    control.cancel();
    expect(cancelButton.disabled).toBe(true);
    resolveFetch(respond(envelope()));
    await first;
    expect(statusEl.textContent).toContain('Voice request cancelled');
    expect(line()).toBeNull();
    expect(recordButton.textContent).toBe('Record distance');
  });

  it('acknowledges cancellation while microphone permission is still pending', async () => {
    vi.mocked(recordMicrophone).mockImplementationOnce(async (signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Voice recording cancelled', 'AbortError')));
    }));
    const first = control.record();
    await flush();
    expect(recordButton.textContent).toBe('Opening microphone…');
    control.cancel();
    expect(statusEl.textContent).toBe('Cancelling voice request… dismiss the microphone permission prompt if it is still open.');
    expect(recordButton.disabled).toBe(true);
    expect(cancelButton.disabled).toBe(true);
    await control.record();
    expect(vi.mocked(recordMicrophone).mock.calls).toHaveLength(1);
    await first;
    expect(statusEl.textContent).toContain('Voice request cancelled');
    expect(recordButton.textContent).toBe('Record distance');
    expect(recordButton.disabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports an invalid JSON response and restores idle', async () => {
    h.recording = { audio: Promise.resolve(wavBlob()), stop: vi.fn(), cancel: vi.fn() };
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } });
    await control.record();
    expect(statusEl.textContent).toContain('Voice server returned an invalid response; restart the Python server after updating');
    expect(recordButton.textContent).toBe('Record distance');
    expect(recordButton.disabled).toBe(false);
    expect(line()).toBeNull();
  });

  it('restores idle after a microphone denial', async () => {
    vi.mocked(recordMicrophone).mockRejectedValue(new Error('Microphone permission was denied'));
    await control.record();
    expect(statusEl.textContent).toContain('Microphone permission was denied');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordButton.textContent).toBe('Record distance');
    expect(notify).toHaveBeenCalledWith('Voice command failed; see the voice panel', true);
  });

  it('stops the active recording from the public stop() and the record button', async () => {
    let resolveAudio: (blob: Blob) => void = () => {};
    h.recording = { audio: new Promise<Blob>((resolve) => { resolveAudio = resolve; }), stop: vi.fn(), cancel: vi.fn() };
    fetchMock.mockResolvedValue(respond(envelope()));
    const first = control.record();
    await flush();
    control.stop();
    expect(h.recording.stop).toHaveBeenCalledTimes(1);
    resolveAudio(wavBlob());
    await first;
    expect(line()!.b).toEqual(v3(400, 500, 300));
  });

  it('keeps panel keystrokes away from the CAD keymap and cancels on pagehide', async () => {
    let rejectAudio: (error: unknown) => void = () => {};
    h.recording = {
      audio: new Promise<Blob>((_resolve, reject) => { rejectAudio = reject; }),
      stop: vi.fn(),
      cancel: vi.fn(() => rejectAudio(new DOMException('Voice recording cancelled', 'AbortError'))),
    };
    const first = control.record();
    await flush();
    const stop = vi.fn();
    root.children[0].fire('keydown', { stopPropagation: stop });
    root.children[0].fire('keyup', { stopPropagation: stop });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(h.pagehide).not.toBeNull();
    h.pagehide!();
    await expect(h.recording.audio).rejects.toMatchObject({ name: 'AbortError' });
    await first;
    expect(statusEl.textContent).toContain('Voice request cancelled');
  });
});
