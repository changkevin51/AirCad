import type { TrackingState } from '../input/cursor';
import type { SpatialCursorState } from '../input/spatial-cursor';
import type { CameraState, ConnectionState, TrackerSource } from '../input/tracker-client';
import type { PlaneInfo } from '../model/plane';
import type { SnapType } from '../model/snap';
import { inputStatus } from './input-panel';

export type Mode = 'READY' | 'DRAWING' | 'EXTRUDING' | 'MOVING' | 'SCALING' | 'ORBIT' | 'PAN';

export interface HudState {
  mode: Mode;
  plane: PlaneInfo;
  planeMode: 'Auto' | 'Manual' | 'Locked';
  planeReason: string | null;
  snap: SnapType | null;
  snapAxis: string | null;
  gridStep: number;
  gridEnabled: boolean;
  tracking: TrackingState;
  connection: ConnectionState;
  camera: CameraState | null;
  cameraMessage?: string | null;
  inputSource: TrackerSource;
  spatialState?: SpatialCursorState | null;
  spatialReason?: string | null;
  collecting?: boolean;
  calibrationSamples?: number;
  calibrationGoal?: number;
  projection: 'Persp' | 'Ortho';
  edgeOn: boolean;
  entityCount: number;
  selected: string | null;
  extrusion: { depth: number; dragging: boolean; face: string; pulled: number } | null;
  /** A blocking dialog (measure entry, help) owns input right now. */
  dialogOpen?: boolean;
  /** Frozen voice draft, e.g. "Line · XY · 32.0°". */
  voice?: string | null;
  /** Read-only presentation view: quiet copy, real tracking health only. */
  presentation?: boolean;
  /** Pen remote mode label, or null until a remote button has been seen. */
  remoteMode?: string | null;
}

export interface KeyHint {
  key: string;
  label: string;
}

const SNAP_NAMES: Record<SnapType, string> = {
  vertex: 'Vertex',
  midpoint: 'Midpoint',
  axis: 'Axis',
  edge: 'Edge',
  grid: 'Grid',
  free: 'Free',
  lock: 'Lock',
};

export function formatGridStep(step: number): string {
  return step >= 1000 ? `${step / 1000} m` : `${step} mm`;
}

/** Status-bar input health: the same labels the Input tab shows. */
export function trackingLabel(state: HudState): { text: string; tone: string } {
  const status = inputStatus({
    connection: state.connection,
    camera: state.camera,
    cameraMessage: state.cameraMessage,
    source: state.inputSource,
    tracking: state.tracking,
    spatialState: state.spatialState,
    spatialReason: state.spatialReason,
    collecting: state.collecting,
    calibrationSamples: state.calibrationSamples,
    calibrationGoal: state.calibrationGoal,
  });
  return { text: status.text, tone: status.tone === 'neutral' ? 'muted' : status.tone };
}

const INSTRUCTIONS: Record<Mode, string> = {
  READY: 'Ready — left-drag to draw, click to select',
  DRAWING: 'Drawing — release to commit',
  EXTRUDING: 'Push/Pull — drag or hold Space to pull',
  MOVING: 'Move — hold Space or drag on the work plane · Enter / M applies',
  SCALING: 'Scale — hold Space or drag a corner · Enter / R applies',
  ORBIT: 'Orbiting — release to stop',
  PAN: 'Panning — release to stop',
};

function instructionFor(state: HudState): string {
  if (state.presentation && state.mode === 'READY') {
    return 'Presentation — orbit or pan to inspect · D or Esc returns to editing';
  }
  if (state.selected && state.mode === 'READY') {
    return `Selected ${state.selected} — L size · Q push/pull · Del delete`;
  }
  if (state.mode === 'READY') {
    return state.tracking === 'keycap'
      ? 'Ready — hold Space to draw, S to select'
      : 'Ready — left-drag to draw, click to select';
  }
  if (state.mode === 'EXTRUDING') {
    return state.tracking === 'keycap'
      ? 'Push/Pull — hold Space and move to pull'
      : 'Push/Pull — drag or hold Space to pull';
  }
  return INSTRUCTIONS[state.mode];
}

/**
 * Status-bar content (left: context instruction plus a few key hints;
 * right: snap · plane · units · input health), the compact viewport notice
 * slot, and the empty-state prompt.  Text writes are value-compared and the
 * right-hand readout is rate-limited so nothing churns per frame.
 */
export class Hud {
  private readonly instruction: HTMLSpanElement;
  private readonly hints: HTMLSpanElement;
  private readonly statusRight: HTMLSpanElement;
  private readonly notice: HTMLDivElement;
  private readonly empty: HTMLDivElement;
  private lastHints = '';
  private lastRight = '';
  private lastRightAt = 0;
  private lastNotice = '';
  private emptyVisible = false;
  private flashText = '';
  private flashTone: 'info' | 'success' = 'info';
  private flashUntil = 0;

  constructor(statusBar: HTMLElement, overlay: HTMLElement, handlers: { onHelp?: () => void } = {}) {
    const left = document.createElement('div');
    left.className = 'ws-status__left';
    this.instruction = document.createElement('span');
    this.instruction.className = 'ws-status__instruction';
    this.hints = document.createElement('span');
    this.hints.className = 'ws-status__hints';
    left.append(this.instruction, this.hints);
    this.statusRight = document.createElement('span');
    this.statusRight.className = 'ws-status__right';
    statusBar.append(left, this.statusRight);

    this.notice = document.createElement('div');
    this.notice.className = 'viewport-notice hidden';
    this.notice.setAttribute('role', 'status');

    this.empty = document.createElement('div');
    this.empty.className = 'empty-state hidden';
    this.empty.setAttribute('data-cad-ui', '');
    const headline = document.createElement('div');
    headline.className = 'empty-state__headline';
    headline.textContent = 'Draw a line or closed outline';
    const sub = document.createElement('div');
    sub.className = 'empty-state__sub';
    sub.textContent = 'Left-drag or hold Space. Click to select.';
    const help = document.createElement('button');
    help.type = 'button';
    help.className = 'empty-state__help';
    help.textContent = 'Help';
    help.addEventListener('click', () => handlers.onHelp?.());
    this.empty.append(headline, sub, help);

    overlay.append(this.notice, this.empty);
  }

  /**
   * Routine feedback (selection, plane/grid toggles, commits) flashes in the
   * status bar's instruction slot for a moment instead of stacking toasts.
   */
  flash(text: string, tone: 'info' | 'success' = 'info', durationMs = 2500): void {
    this.flashText = text;
    this.flashTone = tone;
    this.flashUntil = performance.now() + durationMs;
    this.instruction.textContent = text;
    this.instruction.dataset.tone = tone;
  }

  update(state: HudState): void {
    const now = performance.now();
    let instruction = instructionFor(state);
    if (this.flashText && now < this.flashUntil) {
      instruction = this.flashText;
      this.instruction.dataset.tone = this.flashTone;
    } else {
      this.flashText = '';
      delete this.instruction.dataset.tone;
    }
    if (this.instruction.textContent !== instruction) this.instruction.textContent = instruction;

    const tracking = trackingLabel(state);
    const snapText = state.snap ? `${SNAP_NAMES[state.snap]}${state.snapAxis ? ` ${state.snapAxis.toUpperCase()}` : ''}` : '—';
    const compact = typeof window !== 'undefined' && window.innerWidth <= 1440;
    const right = state.presentation
      ? tracking.text
      : [
          ...(!compact ? [`Snap: ${snapText}`] : []),
          `${state.plane.label} · ${state.planeMode}${state.planeReason ? ` (${state.planeReason})` : ''}`,
          state.gridEnabled ? `Grid ${formatGridStep(state.gridStep)}` : 'Grid snap off',
          ...(state.remoteMode ? [`Pen: ${state.remoteMode}`] : []),
          tracking.text,
        ].join('  ·  ');
    if (right !== this.lastRight && now - this.lastRightAt >= 100) {
      this.lastRight = right;
      this.lastRightAt = now;
      this.statusRight.textContent = right;
      this.statusRight.dataset.tone = tracking.tone;
    }

    const notice = this.noticeText(state);
    if (notice !== this.lastNotice) {
      this.lastNotice = notice;
      this.notice.textContent = notice;
      this.notice.classList.toggle('hidden', !notice);
      this.notice.classList.toggle('viewport-notice--action', !!state.extrusion);
    }

    const emptyVisible = state.entityCount === 0 && state.mode === 'READY' && !state.dialogOpen && !state.presentation;
    if (emptyVisible !== this.emptyVisible) {
      this.emptyVisible = emptyVisible;
      this.empty.classList.toggle('hidden', !emptyVisible);
    }
  }

  /** One notice slot: actionable warnings outrank normal instructions. */
  private noticeText(state: HudState): string {
    if (state.presentation) {
      return state.tracking === 'lost' && state.inputSource !== 'oak'
        ? 'Tracking paused — show your hand to resume, or keep using the mouse.'
        : '';
    }
    if (state.voice) {
      return `Voice draft frozen (${state.voice}) — you may release. Say a distance; V confirms or sends it · Esc cancels.`;
    }
    if (state.extrusion) {
      if (state.tracking === 'lost') {
        return 'Tracking lost — show the green keycap, release Space, then hold it again to resume pulling.';
      }
      if (state.mode === 'ORBIT' || state.mode === 'PAN') {
        return 'Push/Pull paused while you move the view — release to continue.';
      }
      return 'Push/Pull — drag the highlighted face · Enter applies · Esc cancels';
    }
    if (state.edgeOn) {
      return `Work plane ${state.plane.label} is edge-on. Press A for auto, Tab or 1 / 2 / 3, or orbit with Shift.`;
    }
    if (state.mode === 'SCALING') {
      return state.tracking === 'lost'
        ? 'Tracking lost — scaling paused. Show the green keycap, release Space, then hold it again to continue.'
        : 'Hold Space and move the keycap, or drag a corner to scale proportionally. The opposite corner stays fixed. Enter / R applies · Esc cancels.';
    }
    if (state.mode === 'MOVING') {
      return state.tracking === 'lost'
        ? 'Tracking lost — move paused. Show the green keycap, release Space, then hold it again to continue.'
        : 'Hold Space or left-drag to move on the work plane. Tab changes plane. Enter / M applies · Esc cancels.';
    }
    if (state.inputSource === 'oak' && state.spatialState === 'origin') {
      return 'Depth camera needs an origin — press O and hold the keycap center still.';
    }
    if (state.tracking === 'lost' && state.inputSource !== 'oak') {
      return 'Tracking paused — show the green keycap to resume, or keep using the mouse.';
    }
    return '';
  }

  setKeys(hints: readonly KeyHint[]): void {
    const html = hints.map((hint) => `<span class="key"><kbd>${hint.key}</kbd>${hint.label}</span>`).join('');
    if (html === this.lastHints) return;
    this.lastHints = html;
    this.hints.innerHTML = html;
  }
}
