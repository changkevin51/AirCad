export const SAMPLE_RATE = 16_000;
export const MAX_RECORDING_SECONDS = 10;
const MIN_FRAMES = SAMPLE_RATE / 10;

export interface MicrophoneRecording {
  audio: Promise<Blob>;
  stop(): void;
  cancel(): void;
}

export function encodeWav(audio: AudioBuffer): Blob {
  if (audio.sampleRate !== SAMPLE_RATE || audio.numberOfChannels < 1) throw new Error('Unsupported microphone sample rate');
  const count = Math.min(audio.length, SAMPLE_RATE * MAX_RECORDING_SECONDS);
  const buffer = new ArrayBuffer(44 + count * 2);
  const view = new DataView(buffer);
  const tag = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  tag(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true); tag(8, 'WAVE');
  tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, count * 2, true);
  const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
  for (let i = 0; i < count; i++) {
    const sample = Math.max(-1, Math.min(1, channels.reduce((sum, channel) => sum + channel[i], 0) / channels.length));
    view.setInt16(44 + i * 2, Math.round(sample < 0 ? sample * 32768 : sample * 32767), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export async function audioBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

export async function recordMicrophone(signal: AbortSignal): Promise<MicrophoneRecording> {
  const devices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!devices?.getUserMedia || typeof MediaRecorder === 'undefined' || typeof AudioContext === 'undefined') {
    throw new Error('Voice recording needs a browser with microphone support on localhost or HTTPS');
  }
  signal.throwIfAborted();
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  let contextClosed = false;
  const closeContext = (): void => {
    if (contextClosed) return;
    contextClosed = true;
    try {
      void context.close().catch(() => {});
    } catch {}
  };
  let stream: MediaStream | null = null;
  const stopTracks = (): void => {
    const active = stream;
    stream = null;
    if (active) for (const track of active.getTracks()) track.stop();
  };
  let recorder: MediaRecorder;
  try {
    stream = await devices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    signal.throwIfAborted();
    recorder = new MediaRecorder(stream);
  } catch (error) {
    stopTracks();
    closeContext();
    if (signal.aborted) throw new DOMException('Voice recording cancelled', 'AbortError');
    throw error instanceof Error ? error : new Error('Microphone permission was denied');
  }

  const chunks: Blob[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let failAudio: (error: unknown) => void = () => {};
  const stopRecorder = (): void => {
    try {
      if (recorder.state === 'recording') recorder.stop();
    } catch (error) {
      failAudio(error instanceof Error ? error : new Error('Could not stop the microphone recording'));
    }
  };

  const audio = new Promise<Blob>((resolve, reject) => {
    const cleanup = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      signal.removeEventListener('abort', onAbort);
      stopTracks();
      closeContext();
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      stopRecorder();
      cleanup();
      reject(error);
    };
    failAudio = fail;
    const finish = async (): Promise<void> => {
      try {
        if (!chunks.length) throw new Error('The microphone returned no audio');
        const data = await new Blob(chunks).arrayBuffer();
        if (settled) return;
        const decoded = await context.decodeAudioData(data);
        if (settled) return;
        if (decoded.length < MIN_FRAMES) throw new Error('Recording is too short');
        const wav = encodeWav(decoded);
        settled = true;
        cleanup();
        resolve(wav);
      } catch (error) {
        fail(error instanceof Error ? error : new Error('Could not decode the recording'));
      }
    };
    const onAbort = (): void => fail(new DOMException('Voice recording cancelled', 'AbortError'));
    recorder.ondataavailable = (event: BlobEvent) => {
      if (!settled && event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = () => fail(new Error('Microphone recording failed'));
    recorder.onstop = () => {
      if (settled) return;
      stopTracks();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      void finish();
    };
    signal.addEventListener('abort', onAbort);
    timer = setTimeout(() => stopRecorder(), MAX_RECORDING_SECONDS * 1000);
    try {
      recorder.start();
    } catch (error) {
      fail(error instanceof Error ? error : new Error('Could not start the microphone recording'));
    }
  });

  const recording: MicrophoneRecording = {
    audio,
    stop: () => stopRecorder(),
    cancel: () => failAudio(new DOMException('Voice recording cancelled', 'AbortError')),
  };
  return recording;
}
