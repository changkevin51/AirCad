import type { TrackingState } from '../input/cursor';
import { CALIBRATION_MIN_SAMPLES, SCALE_PRESETS, type SpatialCursorState } from '../input/spatial-cursor';
import type {
  CameraState,
  ColorPreset,
  ConnectionState,
  SpatialTarget,
  TrackerConfigJson,
  TrackerSource,
} from '../input/tracker-client';

export interface InputPanelState {
  source: TrackerSource;
  target: SpatialTarget;
  colorPreset: ColorPreset;
  colorTolerance: number;
  scale: number;
  calibrated: boolean;
  depthaiInstalled: boolean;
  connection: ConnectionState;
  camera: CameraState | null;
  cameraMessage?: string | null;
  tracking?: TrackingState;
  spatialState?: SpatialCursorState | null;
  spatialReason?: string | null;
  collecting?: boolean;
  calibrationSamples?: number;
  calibrationGoal?: number;
  streamId?: string | null;
  trackingAgeMs?: number | null;
  navAssist?: boolean;
  pipVisible?: boolean;
  applying: boolean;
}

export interface InputPanelHandlers {
  onSource(source: TrackerSource): void;
  onTarget(target: SpatialTarget): void;
  onColorPreset(preset: ColorPreset): void;
  onColorTolerance(value: number): void;
  onScale(scale: number): void;
  onSetOrigin(): void;
  onRecenter(): void;
  onFitWorkspace(): void;
  onRetry(): void;
  onToggleNavAssist(): void;
  onTogglePip(): void;
  onCancelInteraction(): void;
  onReleaseFocus?: () => void;
}

const SOURCES: { id: TrackerSource; label: string }[] = [
  { id: 'none', label: 'Mouse' },
  { id: 'webcam', label: 'Webcam' },
  { id: 'oak', label: 'Depth camera' },
];

export type InputTone = 'neutral' | 'ok' | 'warn' | 'error';

/** The subset of panel state the status line needs — shared with the HUD. */
export interface InputStatusContext {
  connection: ConnectionState;
  camera: CameraState | null;
  cameraMessage?: string | null;
  source: TrackerSource;
  tracking?: TrackingState;
  spatialState?: SpatialCursorState | null;
  spatialReason?: string | null;
  collecting?: boolean;
  calibrationSamples?: number;
  calibrationGoal?: number;
}

/**
 * One source of truth for "what is the input doing right now".  The status
 * bar and the Input tab both render this so a given state never has two
 * different labels.
 */
export function inputStatus(state: InputStatusContext): { text: string; tone: InputTone; retry: boolean } {
  if (state.connection !== 'open') {
    return { text: 'Tracker offline — reconnecting…', tone: 'warn', retry: false };
  }
  if (state.camera === 'error') {
    return {
      text: state.cameraMessage ? `Camera unavailable: ${state.cameraMessage}` : 'Camera unavailable',
      tone: 'error',
      retry: true,
    };
  }
  if (state.source === 'none') return { text: 'Mouse input active', tone: 'neutral', retry: false };
  if (state.camera === 'disabled') return { text: 'Camera disabled', tone: 'neutral', retry: false };
  if (state.camera === 'starting' || state.camera === null || state.camera === undefined) {
    return { text: 'Camera starting…', tone: 'neutral', retry: false };
  }
  if (state.camera === 'stopped') return { text: 'Camera stopped', tone: 'warn', retry: true };
  if (state.source === 'oak') {
    if (state.collecting) {
      const samples = state.calibrationSamples ?? 0;
      const goal = state.calibrationGoal ?? CALIBRATION_MIN_SAMPLES;
      return { text: `Hold still… ${samples}/${goal}`, tone: 'neutral', retry: false };
    }
    switch (state.spatialState) {
      case 'origin':
        return { text: 'Origin needed — press Set origin', tone: 'warn', retry: false };
      case 'tracked':
        return { text: 'Tracking', tone: 'ok', retry: false };
      case 'held':
        return { text: state.spatialReason ? `Paused (${state.spatialReason})` : 'Paused', tone: 'warn', retry: false };
      case 'lost':
        return { text: 'Target lost — show the tracked tip', tone: 'warn', retry: false };
      default:
        return { text: 'Acquiring…', tone: 'neutral', retry: false };
    }
  }
  switch (state.tracking) {
    case 'hand':
      return { text: 'Tracking', tone: 'ok', retry: false };
    case 'lost':
      return { text: 'Hand lost — show your hand', tone: 'warn', retry: false };
    case 'mouse':
      return { text: 'Camera ready — mouse active', tone: 'neutral', retry: false };
    default:
      return { text: 'Show a hand to track', tone: 'neutral', retry: false };
  }
}

export function buildInputPanelState(
  config: TrackerConfigJson,
  extras: Partial<InputPanelState> = {},
): InputPanelState {
  return {
    source: config.source,
    target: config.target,
    colorPreset: config.colorPreset,
    colorTolerance: config.colorTolerance,
    scale: extras.scale ?? 1,
    calibrated: extras.calibrated ?? false,
    depthaiInstalled: extras.depthaiInstalled ?? false,
    connection: extras.connection ?? 'closed',
    camera: extras.camera ?? null,
    cameraMessage: extras.cameraMessage ?? null,
    tracking: extras.tracking ?? 'none',
    spatialState: extras.spatialState ?? null,
    spatialReason: extras.spatialReason ?? null,
    collecting: extras.collecting ?? false,
    calibrationSamples: extras.calibrationSamples ?? 0,
    calibrationGoal: extras.calibrationGoal ?? CALIBRATION_MIN_SAMPLES,
    streamId: extras.streamId ?? null,
    trackingAgeMs: extras.trackingAgeMs ?? null,
    navAssist: extras.navAssist ?? false,
    pipVisible: extras.pipVisible ?? false,
    applying: extras.applying ?? false,
  };
}

function field(label: string, control: HTMLElement): HTMLLabelElement {
  const wrap = document.createElement('label');
  const text = document.createElement('span');
  text.textContent = label;
  wrap.append(text, control);
  return wrap;
}

function selectOf(options: { value: string; label: string }[]): HTMLSelectElement {
  const select = document.createElement('select');
  for (const { value, label } of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }
  return select;
}

function group(): HTMLDivElement {
  const element = document.createElement('div');
  element.className = 'input-panel__group';
  return element;
}

const DEPTHAI_HINT = 'DepthAI is not installed — pip install -r requirements-depth.txt';

/**
 * Input tab: source select plus per-source controls.  Controls are written
 * back only when they are not focused, so an acknowledged config never
 * clobbers an in-flight edit; a rejected change snaps back once the field
 * loses focus.  Keyboard/pointer isolation comes from the [data-cad-ui]
 * boundary, not from swallowing events here.
 */
export class InputPanel {
  readonly element: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly retry: HTMLButtonElement;
  private readonly mouseGroup: HTMLDivElement;
  private readonly webcamGroup: HTMLDivElement;
  private readonly depthGroup: HTMLDivElement;
  private readonly depthNote: HTMLDivElement;
  private readonly colorFields: HTMLDivElement;
  private readonly sourceSelect: HTMLSelectElement;
  private readonly targetSelect: HTMLSelectElement;
  private readonly colorSelect: HTMLSelectElement;
  private readonly tolerance: HTMLInputElement;
  private readonly scaleSelect: HTMLSelectElement;
  private readonly originButton: HTMLButtonElement;
  private readonly recenterButton: HTMLButtonElement;
  private readonly fitButton: HTMLButtonElement;
  private readonly navToggle: HTMLButtonElement;
  private readonly pipToggle: HTMLButtonElement;
  private readonly diagnostics: HTMLElement;

  constructor(root: HTMLElement, private readonly handlers: InputPanelHandlers) {
    this.element = document.createElement('div');
    this.element.className = 'input-panel';
    const title = document.createElement('div');
    title.className = 'input-panel__title';
    title.textContent = 'Input';

    this.sourceSelect = selectOf(SOURCES.map((s) => ({ value: s.id, label: s.label })));
    this.sourceSelect.addEventListener('change', () => {
      this.handlers.onSource(this.sourceSelect.value as TrackerSource);
    });

    const statusRow = document.createElement('div');
    statusRow.className = 'input-panel__status-row';
    this.status = document.createElement('div');
    this.status.className = 'input-panel__status';
    this.retry = this.actionButton('Retry', 'Ask the tracker to restart the camera', () => this.handlers.onRetry());
    statusRow.append(this.status, this.retry);

    // Mouse ----------------------------------------------------------------
    this.mouseGroup = group();
    const mouseText = document.createElement('div');
    mouseText.className = 'input-panel__status';
    mouseText.textContent = 'Mouse input active.';
    const mouseHint = document.createElement('div');
    mouseHint.className = 'input-panel__hint';
    mouseHint.textContent = 'Left-drag or hold Space to draw; click to select. Shift-drag orbits, Ctrl-drag pans.';
    this.mouseGroup.append(mouseText, mouseHint);

    // Webcam ---------------------------------------------------------------
    this.webcamGroup = group();
    this.navToggle = this.toggleButton('Palm navigation', 'One open palm orbits; two palms pan and zoom (N)', () =>
      this.handlers.onToggleNavAssist(),
    );
    this.pipToggle = this.toggleButton('Camera preview', 'Show the webcam preview inset (P)', () =>
      this.handlers.onTogglePip(),
    );
    this.webcamGroup.append(this.navToggle, this.pipToggle);

    // Depth camera ----------------------------------------------------------
    this.depthGroup = group();
    this.targetSelect = selectOf([
      { value: 'finger', label: 'Finger' },
      { value: 'color', label: 'LED / Colour' },
    ]);
    this.targetSelect.addEventListener('change', () => this.handlers.onTarget(this.targetSelect.value as SpatialTarget));

    this.colorFields = group();
    this.colorSelect = selectOf([
      { value: 'green', label: 'Green' },
      { value: 'red', label: 'Red' },
      { value: 'blue', label: 'Blue' },
    ]);
    this.colorSelect.addEventListener('change', () =>
      this.handlers.onColorPreset(this.colorSelect.value as ColorPreset),
    );
    this.tolerance = document.createElement('input');
    this.tolerance.type = 'range';
    this.tolerance.min = '0.5';
    this.tolerance.max = '2';
    this.tolerance.step = '0.1';
    this.tolerance.addEventListener('change', () => this.handlers.onColorTolerance(Number(this.tolerance.value)));
    this.colorFields.append(field('Colour preset', this.colorSelect), field('Tolerance', this.tolerance));

    this.scaleSelect = selectOf(
      SCALE_PRESETS.map((s) => ({ value: String(s), label: `1 physical mm = ${s} model mm` })),
    );
    this.scaleSelect.addEventListener('change', () => this.handlers.onScale(Number(this.scaleSelect.value)));

    const calibration = document.createElement('div');
    calibration.className = 'input-panel__row';
    this.originButton = this.actionButton('Set origin (O)', 'Hold the tracked tip still to set the workspace origin', () =>
      this.handlers.onSetOrigin(),
    );
    this.recenterButton = this.actionButton('Recenter (R)', 'Recenter the workspace on the last endpoint', () =>
      this.handlers.onRecenter(),
    );
    calibration.append(this.originButton, this.recenterButton);

    const fitRow = document.createElement('div');
    fitRow.className = 'input-panel__row';
    this.fitButton = this.actionButton('Fit workspace (F)', 'Fit the view to the calibrated workspace', () =>
      this.handlers.onFitWorkspace(),
    );
    fitRow.append(this.fitButton);

    this.depthNote = document.createElement('div');
    this.depthNote.className = 'input-panel__hint';
    this.depthNote.textContent = DEPTHAI_HINT;

    this.depthGroup.append(
      field('Target', this.targetSelect),
      this.colorFields,
      field('Mapping scale', this.scaleSelect),
      calibration,
      fitRow,
      this.depthNote,
    );

    // Diagnostics -----------------------------------------------------------
    const details = document.createElement('details');
    details.className = 'input-panel__details';
    const summary = document.createElement('summary');
    summary.textContent = 'Diagnostics';
    this.diagnostics = document.createElement('div');
    this.diagnostics.className = 'input-panel__diag';
    details.append(summary, this.diagnostics);

    this.element.append(
      title,
      field('Source', this.sourceSelect),
      statusRow,
      this.mouseGroup,
      this.webcamGroup,
      this.depthGroup,
      details,
    );
    root.appendChild(this.element);
  }

  /** Pointer-activated one-shot buttons release focus back to the viewport. */
  private actionButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.title = title;
    button.dataset.baseTitle = title;
    let pointer = false;
    button.addEventListener('pointerdown', () => {
      pointer = true;
    });
    button.addEventListener('click', () => {
      onClick();
      if (pointer) this.handlers.onReleaseFocus?.();
      pointer = false;
    });
    return button;
  }

  private toggleButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const button = this.actionButton(label, title, onClick);
    button.classList.add('input-panel__toggle');
    button.setAttribute('aria-pressed', 'false');
    return button;
  }

  /**
   * Selects show the acknowledged config: while a change is being applied a
   * focused select keeps the user's pick, but once the POST resolves the DOM
   * snaps to whatever was acknowledged (a rejection visibly reverts).  The
   * range input additionally never rewrites while focused — mid-drag.
   */
  private syncSelect(input: HTMLSelectElement, value: string, applying: boolean): void {
    if (applying && document.activeElement === input) return;
    if (input.value !== value) input.value = value;
  }

  private syncRange(input: HTMLInputElement, value: string): void {
    if (document.activeElement === input) return;
    if (input.value !== value) input.value = value;
  }

  update(state: InputPanelState): void {
    this.syncSelect(this.sourceSelect, state.source, state.applying);
    this.syncSelect(this.targetSelect, state.target, state.applying);
    this.syncSelect(this.colorSelect, state.colorPreset, state.applying);
    this.syncRange(this.tolerance, String(state.colorTolerance));
    this.syncSelect(this.scaleSelect, String(state.scale), state.applying);

    this.mouseGroup.classList.toggle('hidden', state.source !== 'none');
    this.webcamGroup.classList.toggle('hidden', state.source !== 'webcam');
    this.depthGroup.classList.toggle('hidden', state.source !== 'oak');
    this.colorFields.classList.toggle('hidden', state.target !== 'color');

    const status = inputStatus(state);
    this.status.textContent = status.text;
    this.status.dataset.tone = status.tone;
    this.retry.classList.toggle('hidden', !status.retry);

    this.navToggle.setAttribute('aria-pressed', String(!!state.navAssist));
    this.pipToggle.setAttribute('aria-pressed', String(!!state.pipVisible));

    const applying = state.applying;
    const depthReady = state.depthaiInstalled;
    this.sourceSelect.disabled = applying;
    this.sourceSelect.title = applying ? 'Applying…' : '';
    this.depthNote.classList.toggle('hidden', depthReady);
    const depthControls: (HTMLSelectElement | HTMLInputElement | HTMLButtonElement)[] = [
      this.targetSelect,
      this.colorSelect,
      this.tolerance,
      this.scaleSelect,
      this.originButton,
      this.recenterButton,
      this.fitButton,
    ];
    for (const control of depthControls) {
      control.disabled = applying || !depthReady;
      control.title = applying ? 'Applying…' : depthReady ? (control.dataset.baseTitle ?? '') : DEPTHAI_HINT;
    }

    this.diagnostics.textContent = [
      `Connection: ${state.connection}`,
      `Camera: ${state.camera ?? '—'}`,
      `Stream: ${state.streamId ?? '—'}`,
      `Tracking age: ${state.trackingAgeMs ?? '—'} ms`,
      `Scale: ${state.scale}`,
    ].join('\n');
    this.element.classList.toggle('input-panel--busy', applying);
  }

  fromConfig(config: TrackerConfigJson, extras: Partial<InputPanelState> = {}): InputPanelState {
    return buildInputPanelState(config, extras);
  }
}
