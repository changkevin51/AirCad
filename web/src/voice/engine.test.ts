import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VOICE_ENGINE, isVoiceEngine, loadVoiceEngine, saveVoiceEngine, VOICE_ENGINE_STORAGE_KEY, VOICE_ENGINES,
  voiceEngineLabel, type VoiceEngineStorage,
} from './engine';

const memory = (initial?: string): VoiceEngineStorage & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(VOICE_ENGINE_STORAGE_KEY, initial);
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
};

describe('voice engine setting', () => {
  it('offers the browser recognizer first and defaults to it', () => {
    expect(VOICE_ENGINES).toEqual(['browser', 'qwen']);
    expect(DEFAULT_VOICE_ENGINE).toBe('browser');
    expect(loadVoiceEngine(memory())).toBe('browser');
    expect(loadVoiceEngine(null)).toBe('browser');
  });

  it('round-trips a stored engine', () => {
    const storage = memory();
    saveVoiceEngine('qwen', storage);
    expect(storage.map.get(VOICE_ENGINE_STORAGE_KEY)).toBe('qwen');
    expect(loadVoiceEngine(storage)).toBe('qwen');
    saveVoiceEngine('browser', storage);
    expect(loadVoiceEngine(storage)).toBe('browser');
  });

  it('falls back to the default for unknown or unreadable values', () => {
    expect(loadVoiceEngine(memory('whisper'))).toBe('browser');
    expect(loadVoiceEngine(memory(''))).toBe('browser');
    expect(loadVoiceEngine({
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {},
    })).toBe('browser');
  });

  it('never throws when the store rejects a write', () => {
    expect(() => saveVoiceEngine('qwen', {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
    })).not.toThrow();
  });

  it('guards and labels the engine values', () => {
    expect(isVoiceEngine('browser')).toBe(true);
    expect(isVoiceEngine('qwen')).toBe(true);
    expect(isVoiceEngine('yibu')).toBe(false);
    expect(isVoiceEngine(null)).toBe(false);
    expect(voiceEngineLabel('browser')).toBe('Browser speech (default)');
    expect(voiceEngineLabel('qwen')).toBe('Qwen omni (Python server)');
  });
});
