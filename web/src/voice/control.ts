import { type CommandResult } from '../model/commands';
import { parseVoiceCommand, type VoiceTarget } from './commands';
import {
  isVoiceEngine, loadVoiceEngine, saveVoiceEngine, VOICE_ENGINES, voiceEngineLabel,
  type VoiceEngine, type VoiceEngineStorage,
} from './engine';
import { audioBase64, recordMicrophone, type MicrophoneRecording } from './microphone';
import { listenSpeech, speechRecognitionCtor, UNSUPPORTED_SPEECH, type SpeechHandle, type SpeechHypothesis, type SpeechRecognitionCtor } from './speech';
import { pickMeasurement, type SpokenMeasurement } from './transcript';

export interface VoiceControlOptions {
  capture(): VoiceTarget;
  isCurrent(target: VoiceTarget): boolean;
  execute(command: unknown, target: VoiceTarget): CommandResult;
  notify(message: string, error: boolean): void;
  speechRecognition?: SpeechRecognitionCtor | null;
  /** Overrides the stored setting; used by tests and by callers that pin an engine. */
  engine?: VoiceEngine;
  storage?: VoiceEngineStorage | null;
}

type VoicePhase = 'idle' | 'listening' | 'opening' | 'recording' | 'sending';
const FETCH_TIMEOUT_MS = 310_000;
const STALE_ERROR = 'Operation or geometry changed; press V to retry or Esc to cancel the draft';
const DISTANCE_ERROR = 'Say one positive distance, such as 500 mm or by 1 m';
const IDLE_STATUS: Record<VoiceEngine, string> = {
  browser: 'Start a line or pull a face, then press V while holding. Say “500 mm” or “by 1 m”. Units apply immediately; V confirms a bare number.',
  qwen: 'Start a line or pull a face, then press V while holding. Say “500 mm” or “by 1 m”. V again stops and sends (max 10 s).',
};
const IDLE_LABEL: Record<VoiceEngine, string> = { browser: 'Speak distance', qwen: 'Record distance' };

export class VoiceControl {
  private readonly recordButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly engineSelect: HTMLSelectElement;
  private readonly status: HTMLParagraphElement;
  private engine: VoiceEngine;
  private phase: VoicePhase = 'idle';
  private controller: AbortController | null = null;
  private listener: SpeechHandle | null = null;
  private recording: MicrophoneRecording | null = null;
  private activeTarget: VoiceTarget | null = null;
  private lastTranscript = '';
  private lastAlternatives: string[] = [];
  private committed = false;
  private settleOk: (() => void) | null = null;
  private settleErr: ((error: unknown) => void) | null = null;

  constructor(host: HTMLElement, private readonly options: VoiceControlOptions) {
    this.engine = options.engine ?? loadVoiceEngine(options.storage);
    const panel = document.createElement('section');
    panel.className = 'voice-control';
    panel.setAttribute('data-cad-ui', '');
    this.recordButton = document.createElement('button');
    this.recordButton.type = 'button';
    this.recordButton.className = 'voice-control__record';
    this.recordButton.textContent = IDLE_LABEL[this.engine];
    this.cancelButton = document.createElement('button');
    this.cancelButton.type = 'button';
    this.cancelButton.className = 'voice-control__cancel';
    this.cancelButton.textContent = 'Cancel';
    this.cancelButton.hidden = true;
    const engineLabel = document.createElement('label');
    engineLabel.className = 'voice-control__engine';
    engineLabel.textContent = 'Recognizer ';
    this.engineSelect = document.createElement('select');
    this.engineSelect.className = 'voice-control__engine-select';
    for (const engine of VOICE_ENGINES) {
      const option = document.createElement('option');
      option.value = engine;
      option.textContent = voiceEngineLabel(engine);
      this.engineSelect.appendChild(option);
    }
    this.engineSelect.value = this.engine;
    engineLabel.appendChild(this.engineSelect);
    this.status = document.createElement('p');
    this.status.className = 'voice-control__status';
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.status.textContent = IDLE_STATUS[this.engine];
    panel.append(this.recordButton, this.cancelButton, engineLabel, this.status);
    host.appendChild(panel);

    this.recordButton.addEventListener('click', () => {
      this.recordButton.blur();
      this.toggle();
    });
    this.cancelButton.addEventListener('click', () => {
      this.cancelButton.blur();
      this.cancel();
    });
    this.engineSelect.addEventListener('change', () => this.setEngine(this.engineSelect.value));
    const stopKeys = (event: Event): void => event.stopPropagation();
    panel.addEventListener('keydown', stopKeys);
    panel.addEventListener('keyup', stopKeys);
    window.addEventListener('pagehide', () => this.cancel());
  }

  get activeEngine(): VoiceEngine {
    return this.engine;
  }

  /** Switching mid-request would orphan the microphone, so the select is disabled then. */
  setEngine(value: unknown): void {
    if (!isVoiceEngine(value) || value === this.engine || this.controller) {
      this.engineSelect.value = this.engine;
      return;
    }
    this.engine = value;
    saveVoiceEngine(value, this.options.storage);
    this.engineSelect.value = value;
    this.status.textContent = IDLE_STATUS[value];
    this.recordButton.textContent = IDLE_LABEL[value];
  }

  toggle(): void {
    if (this.phase === 'listening' || this.phase === 'recording') this.stop();
    else if (this.phase === 'idle') void this.start();
  }

  start(): Promise<void> {
    return this.engine === 'qwen' ? this.record() : this.listen();
  }

  async listen(): Promise<void> {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    this.committed = false;
    this.lastTranscript = '';
    this.lastAlternatives = [];
    try {
      const ctor = this.options.speechRecognition === undefined ? speechRecognitionCtor() : this.options.speechRecognition;
      if (!ctor) throw new Error(UNSUPPORTED_SPEECH);
      const target = this.options.capture();
      this.activeTarget = target;
      controller.signal.throwIfAborted();
      this.setPhase('listening');
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finishOk = (): void => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const finishErr = (error: unknown): void => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        this.settleOk = finishOk;
        this.settleErr = finishErr;
        controller.signal.addEventListener('abort', () => {
          finishErr(new DOMException('Voice request cancelled', 'AbortError'));
        });
        try {
          this.listener = listenSpeech({
            signal: controller.signal,
            onResult: (hypothesis) => this.onHypothesis(hypothesis, target, finishOk, finishErr),
            onError: (error) => finishErr(error),
          }, ctor);
        } catch (error) {
          finishErr(error);
        }
      });
    } catch (error) {
      this.reportFailure(controller, error, false);
    } finally {
      this.listener?.abort();
      this.listener = null;
      this.activeTarget = null;
      this.controller = null;
      this.settleOk = null;
      this.settleErr = null;
      this.setPhase('idle');
    }
  }

  /** Opt-in `qwen` path: record WAV audio and let the Python server transcribe it. */
  async record(): Promise<void> {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    let timedOut = false;
    let fetchTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      this.setPhase('opening');
      const target = this.options.capture();
      this.activeTarget = target;
      this.recording = await recordMicrophone(controller.signal);
      controller.signal.throwIfAborted();
      this.setPhase('recording');
      const audio = await this.recording.audio;
      controller.signal.throwIfAborted();
      if (!this.options.isCurrent(target)) throw new Error(STALE_ERROR);
      const encoded = await audioBase64(audio);
      controller.signal.throwIfAborted();
      this.setPhase('sending');
      fetchTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, FETCH_TIMEOUT_MS);
      const response = await fetch('/api/voice/command', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio_wav_base64: encoded, context: target.context }), signal: controller.signal,
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Voice server returned an invalid response; restart the Python server after updating');
      const data = body as Record<string, unknown>;
      if (typeof data.response_text === 'string') console.info('[voice] API response', data.response_text);
      if (typeof data.transcript === 'string') console.info('[voice] transcript', data.transcript);
      if (typeof data.call_id === 'string') console.info('[voice] call_id', data.call_id);
      if (!response.ok || data.ok !== true) throw new Error(typeof data.error === 'string' ? data.error : `Voice server returned HTTP ${response.status}`);
      const command = parseVoiceCommand(data.command);
      controller.signal.throwIfAborted();
      if (!this.options.isCurrent(target)) throw new Error(STALE_ERROR);
      const result = this.options.execute(command, target);
      if (!result.ok) throw new Error(result.error);
      console.info('[voice] executed', { kind: target.operation.kind, command, message: result.message });
      this.status.textContent = `Heard: ${typeof data.transcript === 'string' ? data.transcript : ''}\n${result.message}`;
      this.options.notify(result.message, false);
    } catch (error) {
      this.reportFailure(controller, error, timedOut);
    } finally {
      if (fetchTimer !== null) clearTimeout(fetchTimer);
      this.recording?.cancel();
      this.recording = null;
      this.activeTarget = null;
      this.controller = null;
      this.setPhase('idle');
    }
  }

  stop(): void {
    if (this.phase === 'recording') {
      this.recording?.stop();
      return;
    }
    if (this.phase !== 'listening' || this.committed) return;
    const target = this.activeTarget;
    const finishOk = this.settleOk;
    const finishErr = this.settleErr;
    if (!target || !finishOk || !finishErr) return;
    const parsed = pickMeasurement(this.lastAlternatives.length ? this.lastAlternatives : [this.lastTranscript], 'final');
    this.listener?.stop();
    if (parsed) this.applyMeasurement(parsed, target, finishOk, finishErr);
    else finishErr(new Error(DISTANCE_ERROR));
  }

  cancel(): void {
    if (!this.controller) return;
    this.status.textContent = 'Cancelling voice request… dismiss the microphone permission prompt if it is still open.';
    this.recordButton.disabled = true;
    this.cancelButton.disabled = true;
    this.controller.abort();
  }

  private reportFailure(controller: AbortController, error: unknown, timedOut: boolean): void {
    const aborted = controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
    const detail = aborted ? (timedOut ? 'Voice request timed out' : 'Voice request cancelled')
      : error instanceof Error ? error.message : 'Voice command failed';
    this.status.textContent = aborted ? detail : `${detail} — V retries the frozen draft, Esc cancels it`;
    console.error('[voice] error', detail);
    this.options.notify('Voice command failed; see the voice panel', true);
  }

  private onHypothesis(
    hypothesis: SpeechHypothesis,
    target: VoiceTarget,
    finishOk: () => void,
    finishErr: (error: unknown) => void,
  ): void {
    if (this.committed) return;
    this.lastTranscript = hypothesis.transcript;
    this.lastAlternatives = hypothesis.alternatives;
    this.status.textContent = `Heard: ${hypothesis.transcript}\n${target.description} — say units to apply, or press V to confirm a number.`;
    const parsed = pickMeasurement(hypothesis.alternatives, hypothesis.isFinal ? 'final' : 'interim');
    if (parsed) this.applyMeasurement(parsed, target, finishOk, finishErr);
  }

  private applyMeasurement(
    parsed: SpokenMeasurement,
    target: VoiceTarget,
    finishOk: () => void,
    finishErr: (error: unknown) => void,
  ): void {
    if (this.committed) return;
    if (!this.options.isCurrent(target)) {
      finishErr(new Error(STALE_ERROR));
      return;
    }
    try {
      const command = parseVoiceCommand({ distance_mm: parsed.distance_mm });
      const result = this.options.execute(command, target);
      if (!result.ok) {
        finishErr(new Error(result.error));
        return;
      }
      this.committed = true;
      console.info('[voice] transcript', this.lastTranscript);
      console.info('[voice] executed', { kind: target.operation.kind, command, message: result.message });
      this.status.textContent = `Heard: ${this.lastTranscript}\n${result.message}`;
      this.options.notify(result.message, false);
      finishOk();
    } catch (error) {
      finishErr(error);
    }
  }

  private setPhase(phase: VoicePhase): void {
    this.phase = phase;
    this.cancelButton.disabled = false;
    this.cancelButton.hidden = phase === 'idle';
    this.engineSelect.disabled = phase !== 'idle';
    switch (phase) {
      case 'idle':
        this.recordButton.disabled = false;
        this.recordButton.textContent = IDLE_LABEL[this.engine];
        break;
      case 'listening':
        this.recordButton.disabled = false;
        this.recordButton.textContent = 'Confirm number';
        this.status.textContent = `Listening… ${this.activeTarget?.description ?? ''} — say a distance with units, or press V to confirm a number.`;
        break;
      case 'opening':
        this.recordButton.disabled = true;
        this.recordButton.textContent = 'Opening microphone…';
        break;
      case 'recording':
        this.recordButton.disabled = false;
        this.recordButton.textContent = 'Stop and send';
        this.status.textContent = `Recording… ${this.activeTarget?.description ?? ''} — speak, then press V or click Stop and send (10 s maximum).`;
        break;
      case 'sending':
        this.recordButton.disabled = true;
        this.recordButton.textContent = 'Waiting for Qwen…';
        this.status.textContent = `Waiting for Qwen… ${this.activeTarget?.description ?? ''}`;
        break;
    }
  }
}
