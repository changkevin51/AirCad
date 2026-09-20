import type { ColorPreset, SpatialTarget, TrackerConfigJson, TrackerSource } from '../input/tracker-client';
import { SCALE_PRESETS } from '../input/spatial-cursor';

export interface InputPanelState {
  source: TrackerSource;
  target: SpatialTarget;
  colorPreset: ColorPreset;
  colorTolerance: number;
  scale: number;
  calibrated: boolean;
  depthaiInstalled: boolean;
  status: string;
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
  onCancelInteraction(): void;
  onReleaseFocus?: () => void;
}

const SOURCES: { id: TrackerSource; label: string }[] = [
  { id: 'webcam', label: 'Webcam' },
  { id: 'oak', label: 'Depth camera' },
  { id: 'none', label: 'Mouse' },
];

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
    status: extras.status ?? '',
    applying: extras.applying ?? false,
  };
}

/** Compact source/target/scale panel. Controls never leak Space/Tab into CAD. */
export class InputPanel {
  readonly element: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly depthFields: HTMLDivElement;
  private readonly colorFields: HTMLDivElement;
  private readonly sourceSelect: HTMLSelectElement;
  private readonly targetSelect: HTMLSelectElement;
  private readonly colorSelect: HTMLSelectElement;
  private readonly tolerance: HTMLInputElement;
  private readonly scaleSelect: HTMLSelectElement;
  private readonly hint: HTMLDivElement;

  constructor(root: HTMLElement, private readonly handlers: InputPanelHandlers) {
    this.element = document.createElement('div');
    this.element.className = 'input-panel';
    this.element.innerHTML = `
      <div class="input-panel__title">Input</div>
      <label>Source <select data-field="source">${SOURCES.map((s) => `<option value="${s.id}">${s.label}</option>`).join('')}</select></label>
      <div data-depth>
        <label>Target <select data-field="target"><option value="finger">Finger</option><option value="color">LED / Colour</option></select></label>
        <div data-color>
          <label>Colour <select data-field="color"><option value="green">Green</option><option value="red">Red</option><option value="blue">Blue</option></select></label>
          <label>Tolerance <input data-field="tolerance" type="range" min="0.5" max="2" step="0.1" value="1"></label>
        </div>
        <label>Scale <select data-field="scale">${SCALE_PRESETS.map((s) => `<option value="${s}">1 physical mm = ${s} model mm</option>`).join('')}</select></label>
        <div class="input-panel__row">
          <button type="button" data-action="origin">Set Origin (O)</button>
          <button type="button" data-action="recenter">Recenter (Shift+R)</button>
        </div>
        <div class="input-panel__row">
          <button type="button" data-action="fit">Fit workspace (F)</button>
          <button type="button" data-action="retry">Retry</button>
        </div>
      </div>
      <div class="input-panel__hint" data-hint></div>
      <div class="input-panel__status" data-status></div>
    `;
    this.sourceSelect = this.element.querySelector('[data-field="source"]')!;
    this.targetSelect = this.element.querySelector('[data-field="target"]')!;
    this.colorSelect = this.element.querySelector('[data-field="color"]')!;
    this.tolerance = this.element.querySelector('[data-field="tolerance"]')!;
    this.scaleSelect = this.element.querySelector('[data-field="scale"]')!;
    this.depthFields = this.element.querySelector('[data-depth]')!;
    this.colorFields = this.element.querySelector('[data-color]')!;
    this.status = this.element.querySelector('[data-status]')!;
    this.hint = this.element.querySelector('[data-hint]')!;
    this.bind();
    root.appendChild(this.element);
  }

  private bind(): void {
    this.element.addEventListener('pointerdown', (event) => {
      const action = (event.target as HTMLElement | null)?.closest?.('[data-action]')?.getAttribute('data-action');
      if (action === 'origin' || action === 'recenter') return;
      this.handlers.onCancelInteraction();
    });
    this.element.addEventListener('keydown', (event) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      const inField = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
      if (inField && (event.code === 'Space' || event.code === 'Tab')) event.stopPropagation();
      if (inField && event.code === 'Space') event.preventDefault();
      if (!inField && event.code === 'Space') event.preventDefault();
    });
    const afterControl = () => this.handlers.onReleaseFocus?.();
    this.sourceSelect.addEventListener('change', () => {
      this.handlers.onSource(this.sourceSelect.value as TrackerSource);
      afterControl();
    });
    this.targetSelect.addEventListener('change', () => {
      this.handlers.onTarget(this.targetSelect.value as SpatialTarget);
      afterControl();
    });
    this.colorSelect.addEventListener('change', () => {
      this.handlers.onColorPreset(this.colorSelect.value as ColorPreset);
      afterControl();
    });
    this.tolerance.addEventListener('change', () => {
      this.handlers.onColorTolerance(Number(this.tolerance.value));
      afterControl();
    });
    this.scaleSelect.addEventListener('change', () => {
      this.handlers.onScale(Number(this.scaleSelect.value));
      afterControl();
    });
    this.element.querySelector('[data-action="origin"]')!.addEventListener('click', () => {
      this.handlers.onSetOrigin();
      afterControl();
    });
    this.element.querySelector('[data-action="recenter"]')!.addEventListener('click', () => {
      this.handlers.onRecenter();
      afterControl();
    });
    this.element.querySelector('[data-action="fit"]')!.addEventListener('click', () => {
      this.handlers.onFitWorkspace();
      afterControl();
    });
    this.element.querySelector('[data-action="retry"]')!.addEventListener('click', () => {
      this.handlers.onRetry();
      afterControl();
    });
  }

  update(state: InputPanelState): void {
    this.sourceSelect.value = state.source;
    this.targetSelect.value = state.target;
    this.colorSelect.value = state.colorPreset;
    this.tolerance.value = String(state.colorTolerance);
    this.scaleSelect.value = String(state.scale);
    const depth = state.source === 'oak';
    this.depthFields.classList.toggle('hidden', !depth);
    this.colorFields.classList.toggle('hidden', !(depth && state.target === 'color'));
    this.status.textContent = state.applying ? 'Applying…' : state.status;
    this.hint.textContent = depth
      ? state.depthaiInstalled
        ? state.calibrated
          ? 'Hold Space to draw on the work plane. O sets the origin.'
          : 'Stand in a comfortable pose and press Set Origin (O).'
        : 'DepthAI is not installed. pip install -r requirements-depth.txt'
      : '';
    this.element.classList.toggle('input-panel--busy', state.applying);
  }

  fromConfig(config: TrackerConfigJson, extras: Partial<InputPanelState> = {}): InputPanelState {
    return buildInputPanelState(config, extras);
  }
}
