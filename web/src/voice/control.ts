import { type CommandResult } from '../model/commands';
import { parseVoiceCommand, type VoiceTarget } from './commands';
import { audioBase64, recordMicrophone, type MicrophoneRecording } from './microphone';

export interface VoiceControlOptions {
  capture(): VoiceTarget;
  isCurrent(target: VoiceTarget): boolean;
  execute(command: unknown, target: VoiceTarget): CommandResult;
  notify(message: string, error: boolean): void;
}

type VoicePhase = 'idle' | 'opening' | 'recording' | 'sending';
const FETCH_TIMEOUT_MS = 310_000;
const STALE_ERROR = 'Operation or geometry changed; press V to retry or Esc to cancel the draft';

export class VoiceControl {
  private readonly recordButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly status: HTMLParagraphElement;
  private phase: VoicePhase = 'idle';
  private controller: AbortController | null = null;
  private recording: MicrophoneRecording | null = null;
  private activeTarget: VoiceTarget | null = null;

  constructor(host: HTMLElement, private readonly options: VoiceControlOptions) {
    const panel = document.createElement('section');
    panel.className = 'voice-control';
    this.recordButton = document.createElement('button');
    this.recordButton.type = 'button';
    this.recordButton.className = 'voice-control__record';
    this.recordButton.textContent = 'Record distance';
    this.cancelButton = document.createElement('button');
    this.cancelButton.type = 'button';
    this.cancelButton.className = 'voice-control__cancel';
    this.cancelButton.textContent = 'Cancel';
    this.cancelButton.hidden = true;
    this.status = document.createElement('p');
    this.status.className = 'voice-control__status';
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.status.textContent = 'Start a line or pull a face, then press V while holding. Say “500 mm” or “by 1 m”. V again stops and sends (max 10 s).';
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
    if (this.phase === 'recording') this.stop();
    else if (this.phase === 'idle') void this.record();
  }

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
      const aborted = controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
      const detail = aborted ? (timedOut ? 'Voice request timed out' : 'Voice request cancelled')
        : error instanceof Error ? error.message : 'Voice command failed';
      this.status.textContent = aborted ? detail : `${detail} — V retries the frozen draft, Esc cancels it`;
      console.error('[voice] error', detail);
      this.options.notify('Voice command failed; see the voice panel', true);
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
    this.recording?.stop();
  }

  cancel(): void {
    if (!this.controller) return;
    this.status.textContent = 'Cancelling voice request… dismiss the microphone permission prompt if it is still open.';
    this.recordButton.disabled = true;
    this.cancelButton.disabled = true;
    this.controller.abort();
  }

  private setPhase(phase: VoicePhase): void {
    this.phase = phase;
    this.cancelButton.disabled = false;
    this.cancelButton.hidden = phase === 'idle';
    switch (phase) {
      case 'idle':
        this.recordButton.disabled = false;
        this.recordButton.textContent = 'Record distance';
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
        this.recordButton.textContent = 'Waiting for Yibu…';
        this.status.textContent = 'Waiting for Yibu…';
        break;
    }
  }
}
