import { type CommandResult } from '../model/commands';
import { parseVoiceCommand, type VoiceTarget } from './commands';
import { listenSpeech, speechRecognitionCtor, UNSUPPORTED_SPEECH, type SpeechHandle, type SpeechHypothesis, type SpeechRecognitionCtor } from './speech';
import { pickMeasurement, type SpokenMeasurement } from './transcript';

export interface VoiceControlOptions {
  capture(): VoiceTarget;
  isCurrent(target: VoiceTarget): boolean;
  execute(command: unknown, target: VoiceTarget): CommandResult;
  notify(message: string, error: boolean): void;
  speechRecognition?: SpeechRecognitionCtor | null;
}

type VoicePhase = 'idle' | 'listening';
const STALE_ERROR = 'Operation or geometry changed; press V to retry or Esc to cancel the draft';
const DISTANCE_ERROR = 'Say one positive distance, such as 500 mm or by 1 m';
const IDLE_STATUS = 'Start a line or pull a face, then press V while holding. Say “500 mm” or “by 1 m”. Units apply immediately; V confirms a bare number.';

export class VoiceControl {
  private readonly recordButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly status: HTMLParagraphElement;
  private phase: VoicePhase = 'idle';
  private controller: AbortController | null = null;
  private listener: SpeechHandle | null = null;
  private activeTarget: VoiceTarget | null = null;
  private lastTranscript = '';
  private lastAlternatives: string[] = [];
  private committed = false;
  private settleOk: (() => void) | null = null;
  private settleErr: ((error: unknown) => void) | null = null;

  constructor(host: HTMLElement, private readonly options: VoiceControlOptions) {
    const panel = document.createElement('section');
    panel.className = 'voice-control';
    this.recordButton = document.createElement('button');
    this.recordButton.type = 'button';
    this.recordButton.className = 'voice-control__record';
    this.recordButton.textContent = 'Speak distance';
    this.cancelButton = document.createElement('button');
    this.cancelButton.type = 'button';
    this.cancelButton.className = 'voice-control__cancel';
    this.cancelButton.textContent = 'Cancel';
    this.cancelButton.hidden = true;
    this.status = document.createElement('p');
    this.status.className = 'voice-control__status';
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.status.textContent = IDLE_STATUS;
    panel.append(this.recordButton, this.cancelButton, this.status);
    host.appendChild(panel);

    this.recordButton.addEventListener('click', () => {
      this.recordButton.blur();
      this.toggle();
    });
    this.cancelButton.addEventListener('click', () => {
      this.cancelButton.blur();
      this.cancel();
    });
    const stopKeys = (event: Event): void => event.stopPropagation();
    panel.addEventListener('keydown', stopKeys);
    panel.addEventListener('keyup', stopKeys);
    window.addEventListener('pagehide', () => this.cancel());
  }

  toggle(): void {
    if (this.phase === 'listening') this.stop();
    else if (this.phase === 'idle') void this.listen();
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
      const aborted = controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
      const detail = aborted ? 'Voice request cancelled'
        : error instanceof Error ? error.message : 'Voice command failed';
      this.status.textContent = aborted ? detail : `${detail} — V retries the frozen draft, Esc cancels it`;
      console.error('[voice] error', detail);
      this.options.notify('Voice command failed; see the voice panel', true);
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

  stop(): void {
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
    switch (phase) {
      case 'idle':
        this.recordButton.disabled = false;
        this.recordButton.textContent = 'Speak distance';
        break;
      case 'listening':
        this.recordButton.disabled = false;
        this.recordButton.textContent = 'Confirm number';
        this.status.textContent = `Listening… ${this.activeTarget?.description ?? ''} — say a distance with units, or press V to confirm a number.`;
        break;
    }
  }
}
