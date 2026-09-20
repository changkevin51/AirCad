import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioBase64, encodeWav, MAX_RECORDING_SECONDS, recordMicrophone, SAMPLE_RATE } from './microphone';

const fakeAudioBuffer = (channels: Float32Array[], sampleRate = SAMPLE_RATE): AudioBuffer => ({
  sampleRate,
  numberOfChannels: channels.length,
  length: channels[0]?.length ?? 0,
  getChannelData: (index: number) => channels[index],
}) as AudioBuffer;

const tag = (view: DataView, offset: number, length: number): string => {
  let text = '';
  for (let i = 0; i < length; i++) text += String.fromCharCode(view.getUint8(offset + i));
  return text;
};

describe('encodeWav', () => {
  it('writes a mono 16 kHz PCM16 WAV header', async () => {
    const view = new DataView(await encodeWav(fakeAudioBuffer([new Float32Array([0])])).arrayBuffer());
    expect(tag(view, 0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(38);
    expect(tag(view, 8, 4)).toBe('WAVE');
    expect(tag(view, 12, 4)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(tag(view, 36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(2);
  });

  it('maps full-scale samples onto signed 16-bit values', async () => {
    const view = new DataView(await encodeWav(fakeAudioBuffer([new Float32Array([-1, 0, 1])])).arrayBuffer());
    expect(view.getInt16(44, true)).toBe(-32768);
    expect(view.getInt16(46, true)).toBe(0);
    expect(view.getInt16(48, true)).toBe(32767);
  });

  it('downmixes stereo into one channel', async () => {
    const view = new DataView(await encodeWav(fakeAudioBuffer([new Float32Array([1, 0.5]), new Float32Array([-1, 0.5])])).arrayBuffer());
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(16384);
  });

  it('clips the recording at ten seconds', async () => {
    const blob = encodeWav(fakeAudioBuffer([new Float32Array(SAMPLE_RATE * MAX_RECORDING_SECONDS + 5000)]));
    expect(blob.size).toBe(44 + SAMPLE_RATE * MAX_RECORDING_SECONDS * 2);
  });

  it('rejects unsupported buffers', () => {
    expect(() => encodeWav(fakeAudioBuffer([new Float32Array(10)], 8000))).toThrow('Unsupported');
    expect(() => encodeWav(fakeAudioBuffer([]))).toThrow('Unsupported');
  });
});

describe('audioBase64', () => {
  it('round-trips the exact WAV bytes', async () => {
    const blob = encodeWav(fakeAudioBuffer([new Float32Array([-1, -0.5, 0, 0.5, 1])]));
    const decoded = atob(await audioBase64(blob));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(decoded.length).toBe(bytes.length);
    for (let i = 0; i < bytes.length; i++) expect(decoded.charCodeAt(i)).toBe(bytes[i]);
  });
});

class FakeTrack {
  readonly stop = vi.fn();
}

class FakeStream {
  constructor(readonly trackList: FakeTrack[]) {}
  getTracks(): FakeTrack[] {
    return this.trackList;
  }
}

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static startError: Error | null = null;
  static stopError: Error | null = null;
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: (() => void) | null = null;
  onstop: (() => void) | null = null;
  readonly stream: FakeStream;
  constructor(stream: FakeStream) {
    this.stream = stream;
    FakeRecorder.instances.push(this);
  }
  start(): void {
    if (FakeRecorder.startError) throw FakeRecorder.startError;
    this.state = 'recording';
  }
  stop(): void {
    if (FakeRecorder.stopError) throw FakeRecorder.stopError;
    this.state = 'inactive';
    this.onstop?.();
  }
  emitData(data: Blob): void {
    this.ondataavailable?.({ data });
  }
  emitError(): void {
    this.onerror?.();
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  readonly sampleRate = SAMPLE_RATE;
  closed = false;
  decodeError: Error | null = null;
  decodeResult: AudioBuffer = fakeAudioBuffer([new Float32Array(SAMPLE_RATE / 10)]);
  constructor(readonly options: unknown) {
    FakeAudioContext.instances.push(this);
  }
  decodeAudioData(_data: ArrayBuffer): Promise<AudioBuffer> {
    return this.decodeError ? Promise.reject(this.decodeError) : Promise.resolve(this.decodeResult);
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

describe('recordMicrophone', () => {
  let track: FakeTrack;
  let stream: FakeStream;
  let getUserMedia: ReturnType<typeof vi.fn>;
  let controller: AbortController;

  const lastRecorder = (): FakeRecorder => FakeRecorder.instances[FakeRecorder.instances.length - 1];
  const lastContext = (): FakeAudioContext => FakeAudioContext.instances[FakeAudioContext.instances.length - 1];
  const chunk = (): Blob => new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' });

  beforeEach(() => {
    FakeRecorder.instances = [];
    FakeRecorder.startError = null;
    FakeRecorder.stopError = null;
    FakeAudioContext.instances = [];
    track = new FakeTrack();
    stream = new FakeStream([track]);
    getUserMedia = vi.fn(async () => stream);
    controller = new AbortController();
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('rejects when microphone capture is not supported', async () => {
    vi.stubGlobal('navigator', {});
    await expect(recordMicrophone(controller.signal)).rejects.toThrow(/localhost or HTTPS|microphone support/i);
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it('stops on demand, decodes to WAV and releases every resource', async () => {
    const recording = await recordMicrophone(controller.signal);
    const recorder = lastRecorder();
    recorder.emitData(chunk());
    recording.stop();
    const blob = await recording.audio;
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(44 + (SAMPLE_RATE / 10) * 2);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    expect(FakeAudioContext.instances[0].options).toEqual({ sampleRate: SAMPLE_RATE });
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(lastContext().closed).toBe(true);
  });

  it('stops automatically after ten seconds', async () => {
    vi.useFakeTimers();
    const recording = await recordMicrophone(controller.signal);
    lastRecorder().emitData(chunk());
    await vi.advanceTimersByTimeAsync(MAX_RECORDING_SECONDS * 1000);
    const blob = await recording.audio;
    expect(blob.type).toBe('audio/wav');
    expect(lastRecorder().state).toBe('inactive');
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects and cleans up when permission is denied', async () => {
    getUserMedia.mockRejectedValue(new Error('permission denied'));
    await expect(recordMicrophone(controller.signal)).rejects.toThrow('permission denied');
    expect(FakeRecorder.instances).toHaveLength(0);
    expect(lastContext().closed).toBe(true);
  });

  it('never starts the recorder when aborted while permission is pending', async () => {
    let resolveMedia: (value: FakeStream) => void = () => {};
    getUserMedia.mockImplementation(() => new Promise<FakeStream>((resolve) => { resolveMedia = resolve; }));
    const pending = recordMicrophone(controller.signal);
    controller.abort();
    resolveMedia(stream);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeRecorder.instances).toHaveLength(0);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(lastContext().closed).toBe(true);
  });

  it('rejects the audio and releases resources when aborted while recording', async () => {
    vi.useFakeTimers();
    const recording = await recordMicrophone(controller.signal);
    controller.abort();
    await expect(recording.audio).rejects.toMatchObject({ name: 'AbortError' });
    expect(lastRecorder().state).toBe('inactive');
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(lastContext().closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects when the recorder produces no audio', async () => {
    const recording = await recordMicrophone(controller.signal);
    recording.stop();
    await expect(recording.audio).rejects.toThrow('no audio');
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(lastContext().closed).toBe(true);
  });

  it('rejects and cleans up on a recorder error', async () => {
    const recording = await recordMicrophone(controller.signal);
    lastRecorder().emitError();
    await expect(recording.audio).rejects.toThrow('Microphone recording failed');
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(lastContext().closed).toBe(true);
  });

  it('rejects and cleans up when decoding fails', async () => {
    const recording = await recordMicrophone(controller.signal);
    lastContext().decodeError = new Error('undecodable');
    lastRecorder().emitData(chunk());
    recording.stop();
    await expect(recording.audio).rejects.toThrow('undecodable');
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(lastContext().closed).toBe(true);
  });

  it('rejects recordings shorter than 100 ms', async () => {
    const recording = await recordMicrophone(controller.signal);
    lastContext().decodeResult = fakeAudioBuffer([new Float32Array(SAMPLE_RATE / 10 - 1)]);
    lastRecorder().emitData(chunk());
    recording.stop();
    await expect(recording.audio).rejects.toThrow('too short');
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(lastContext().closed).toBe(true);
  });

  it('rejects audio and releases resources when the recorder cannot start', async () => {
    vi.useFakeTimers();
    FakeRecorder.startError = new Error('start failed');
    const recording = await recordMicrophone(controller.signal);
    await expect(recording.audio).rejects.toThrow('start failed');
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(lastContext().closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects audio instead of hanging when stopping the recorder throws', async () => {
    const recording = await recordMicrophone(controller.signal);
    FakeRecorder.stopError = new Error('stop failed');
    recording.stop();
    await expect(recording.audio).rejects.toThrow('stop failed');
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(lastContext().closed).toBe(true);
  });

  it('releases tracks at stop while decode is still pending, then closes the context', async () => {
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    const recording = await recordMicrophone(controller.signal);
    const context = lastContext();
    let resolveDecode: (buffer: AudioBuffer) => void = () => {};
    context.decodeAudioData = () => new Promise<AudioBuffer>((resolve) => { resolveDecode = resolve; });
    lastRecorder().emitData(chunk());
    recording.stop();
    await flush();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(context.closed).toBe(false);
    resolveDecode(fakeAudioBuffer([new Float32Array(SAMPLE_RATE / 10)]));
    const blob = await recording.audio;
    expect(blob.type).toBe('audio/wav');
    expect(context.closed).toBe(true);
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('never resolves audio after cancel during decode, but still releases resources', async () => {
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    const recording = await recordMicrophone(controller.signal);
    const context = lastContext();
    let resolveDecode: (buffer: AudioBuffer) => void = () => {};
    context.decodeAudioData = () => new Promise<AudioBuffer>((resolve) => { resolveDecode = resolve; });
    lastRecorder().emitData(chunk());
    recording.stop();
    await flush();
    recording.cancel();
    await expect(recording.audio).rejects.toMatchObject({ name: 'AbortError' });
    resolveDecode(fakeAudioBuffer([new Float32Array(SAMPLE_RATE / 10)]));
    await flush();
    await expect(recording.audio).rejects.toMatchObject({ name: 'AbortError' });
    expect(context.closed).toBe(true);
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('cancel rejects the audio and ignores late recorder events', async () => {
    const recording = await recordMicrophone(controller.signal);
    recording.cancel();
    await expect(recording.audio).rejects.toMatchObject({ name: 'AbortError' });
    lastRecorder().emitData(chunk());
    lastRecorder().stop();
    await expect(recording.audio).rejects.toMatchObject({ name: 'AbortError' });
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(lastContext().closed).toBe(true);
  });
});
