import { describe, expect, it, vi } from 'vitest';
import {
  listenSpeech,
  speechRecognitionCtor,
  UNSUPPORTED_SPEECH,
  type SpeechHypothesis,
  type SpeechRecognitionEventLike,
  type SpeechRecognitionHandle,
  type SpeechRecognitionResultLike,
} from './speech';

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

const rec = (): FakeRecognition => {
  if (!current) throw new Error('expected a FakeRecognition instance');
  return current;
};

describe('speechRecognitionCtor', () => {
  it('prefers SpeechRecognition then webkitSpeechRecognition', () => {
    expect(speechRecognitionCtor({})).toBeNull();
    expect(speechRecognitionCtor({ webkitSpeechRecognition: FakeRecognition })).toBe(FakeRecognition);
    expect(speechRecognitionCtor({ SpeechRecognition: FakeRecognition, webkitSpeechRecognition: class {} as never })).toBe(FakeRecognition);
  });
});

describe('listenSpeech', () => {
  it('throws when the browser has no speech recognition', () => {
    expect(() => listenSpeech({ onResult: () => {}, onError: () => {} }, null)).toThrow(UNSUPPORTED_SPEECH);
  });

  it('configures streaming recognition and reports interim and final results', () => {
    const onResult = vi.fn();
    const handle = listenSpeech({ onResult, onError: () => {} }, FakeRecognition);
    expect(rec().continuous).toBe(true);
    expect(rec().interimResults).toBe(true);
    expect(rec().maxAlternatives).toBe(3);
    expect(rec().lang).toBe('en-US');
    expect(rec().startCount).toBe(1);

    rec().emit(false, '500 mm', '500 millimeters');
    rec().emit(true, '500 mm');
    expect(onResult.mock.calls.map((call) => call[0] as SpeechHypothesis)).toEqual([
      { transcript: '500 mm', alternatives: ['500 mm', '500 millimeters'], isFinal: false },
      { transcript: '500 mm', alternatives: ['500 mm'], isFinal: true },
    ]);
    handle.abort();
  });

  it('restarts when Chromium ends the session while still listening', () => {
    const handle = listenSpeech({ onResult: () => {}, onError: () => {} }, FakeRecognition);
    rec().onend?.();
    expect(rec().startCount).toBe(2);
    handle.abort();
  });

  it('does not restart after abort or stop', () => {
    const aborted = listenSpeech({ onResult: () => {}, onError: () => {} }, FakeRecognition);
    const first = rec();
    aborted.abort();
    expect(first.abortCount).toBe(1);
    expect(first.startCount).toBe(1);

    const stopped = listenSpeech({ onResult: () => {}, onError: () => {} }, FakeRecognition);
    const second = rec();
    stopped.stop();
    expect(second.stopCount).toBe(1);
    expect(second.startCount).toBe(1);
  });

  it('maps permission errors and ignores no-speech', () => {
    const onError = vi.fn();
    const handle = listenSpeech({ onResult: () => {}, onError }, FakeRecognition);
    rec().onerror?.({ error: 'no-speech' });
    expect(onError).not.toHaveBeenCalled();
    rec().onerror?.({ error: 'not-allowed' });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Microphone permission was denied' }));
    handle.abort();
  });
});
