export const UNSUPPORTED_SPEECH = 'Voice needs Chrome or Edge on localhost or HTTPS';

export interface SpeechHypothesis {
  transcript: string;
  alternatives: string[];
  isFinal: boolean;
}

export interface SpeechHandle {
  stop(): void;
  abort(): void;
}

export interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

export interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

export interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

export interface SpeechRecognitionHandle {
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type SpeechRecognitionCtor = new () => SpeechRecognitionHandle;

type SpeechGlobal = {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
};

export function speechRecognitionCtor(global: SpeechGlobal = globalThis as SpeechGlobal): SpeechRecognitionCtor | null {
  return global.SpeechRecognition ?? global.webkitSpeechRecognition ?? null;
}

export function listenSpeech(
  options: {
    onResult: (hypothesis: SpeechHypothesis) => void;
    onError: (error: Error) => void;
    signal?: AbortSignal;
  },
  create: SpeechRecognitionCtor | null = speechRecognitionCtor(),
): SpeechHandle {
  if (!create) throw new Error(UNSUPPORTED_SPEECH);
  if (options.signal?.aborted) throw new DOMException('Voice request cancelled', 'AbortError');

  let stopping = false;
  const rec = new create();
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 3;
  rec.lang = 'en-US';

  const stopListening = (hard: boolean): void => {
    stopping = true;
    try {
      if (hard) rec.abort();
      else rec.stop();
    } catch { /* already stopped */ }
  };

  rec.onresult = (event) => {
    if (stopping) return;
    for (let index = event.resultIndex; index < event.results.length; index++) {
      const result = event.results[index];
      const alternatives: string[] = [];
      for (let alt = 0; alt < result.length; alt++) {
        const text = result[alt]?.transcript.trim();
        if (text) alternatives.push(text);
      }
      if (!alternatives.length) continue;
      options.onResult({ transcript: alternatives[0], alternatives, isFinal: result.isFinal });
    }
  };

  rec.onerror = (event) => {
    if (stopping || event.error === 'aborted' || event.error === 'no-speech') return;
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      stopping = true;
      options.onError(new Error('Microphone permission was denied'));
      return;
    }
    if (event.error === 'network') {
      stopping = true;
      options.onError(new Error('Speech recognition could not reach the browser speech service'));
      return;
    }
    if (event.error === 'audio-capture') {
      stopping = true;
      options.onError(new Error('Microphone permission was denied'));
    }
  };

  rec.onend = () => {
    if (stopping) return;
    try {
      rec.start();
    } catch (error) {
      stopping = true;
      options.onError(error instanceof Error ? error : new Error('Could not restart speech recognition'));
    }
  };

  const onAbort = (): void => stopListening(true);
  options.signal?.addEventListener('abort', onAbort);

  try {
    rec.start();
  } catch (error) {
    options.signal?.removeEventListener('abort', onAbort);
    throw error instanceof Error ? error : new Error('Could not start speech recognition');
  }

  return {
    stop: () => stopListening(false),
    abort: () => {
      options.signal?.removeEventListener('abort', onAbort);
      stopListening(true);
    },
  };
}
