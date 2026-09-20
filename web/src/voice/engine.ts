// Which recognizer the voice panel uses. `browser` is the default live path: the
// browser streams a transcript and AirCAD parses the distance locally. `qwen` is the
// opt-in setting that records WAV audio and posts it to the Python server, which
// forwards it to the Yibu `qwen3.5-omni-flash` endpoint.
export type VoiceEngine = 'browser' | 'qwen';

export const VOICE_ENGINES: readonly VoiceEngine[] = ['browser', 'qwen'];
export const DEFAULT_VOICE_ENGINE: VoiceEngine = 'browser';
export const VOICE_ENGINE_STORAGE_KEY = 'aircad.voice.engine';

export interface VoiceEngineStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const LABELS: Record<VoiceEngine, string> = {
  browser: 'Browser speech (default)',
  qwen: 'Qwen omni (Python server)',
};

export function voiceEngineLabel(engine: VoiceEngine): string {
  return LABELS[engine];
}

export function isVoiceEngine(value: unknown): value is VoiceEngine {
  return typeof value === 'string' && (VOICE_ENGINES as readonly string[]).includes(value);
}

export function defaultEngineStorage(): VoiceEngineStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Storage access can throw outright when cookies/site data are blocked.
    return null;
  }
}

export function loadVoiceEngine(storage: VoiceEngineStorage | null = defaultEngineStorage()): VoiceEngine {
  try {
    const stored = storage?.getItem(VOICE_ENGINE_STORAGE_KEY);
    return isVoiceEngine(stored) ? stored : DEFAULT_VOICE_ENGINE;
  } catch {
    return DEFAULT_VOICE_ENGINE;
  }
}

export function saveVoiceEngine(engine: VoiceEngine, storage: VoiceEngineStorage | null = defaultEngineStorage()): void {
  try {
    storage?.setItem(VOICE_ENGINE_STORAGE_KEY, engine);
  } catch {
    // A full or unavailable store must not break the session's in-memory choice.
  }
}
