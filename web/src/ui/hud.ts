import type { TrackingState } from '../input/cursor';
import type { CameraState, ConnectionState } from '../input/tracker-client';
import type { PlaneInfo } from '../model/plane';
import type { SnapType } from '../model/snap';

export type Mode = 'READY' | 'DRAWING' | 'ORBIT' | 'PAN';

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
  projection: 'Persp' | 'Ortho';
  navAssist: boolean;
  edgeOn: boolean;
  entityCount: number;
  depthMode?: boolean;
  spatialLabel?: string | null;
  scale?: number | null;
  trackingAgeMs?: number | null;
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

export function trackingLabel(state: HudState): { text: string; tone: string } {
  if (state.connection !== 'open') return { text: 'Tracker offline · mouse', tone: 'warn' };
  if (state.camera === 'disabled') return { text: 'Mouse (no camera)', tone: 'muted' };
  if (state.camera === 'error' || state.camera === 'stopped') {
    return { text: state.depthMode ? 'Camera error' : 'Camera error · mouse', tone: 'warn' };
  }
  if (state.camera === 'starting') return { text: 'Camera starting', tone: 'muted' };
  if (state.depthMode) {
    const label = state.spatialLabel ?? 'Acquiring';
    const tone = label === 'Tracking' ? 'ok' : label === 'Paused' || label === 'Lost' || label === 'Origin needed' ? 'warn' : 'muted';
    return { text: label, tone };
  }
  switch (state.tracking) {
    case 'hand':
      return { text: 'Hand', tone: 'ok' };
    case 'lost':
      return { text: 'Hand lost', tone: 'warn' };
    case 'mouse':
      return { text: 'Mouse', tone: 'muted' };
    default:
      return { text: 'Show a hand', tone: 'muted' };
  }
}

/** Top-left status chips and the bottom context key bar. */
export class Hud {
  private readonly chips: HTMLDivElement;
  private readonly keyBar: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private lastChips = '';
  private lastKeys = '';

  constructor(root: HTMLElement) {
    this.chips = document.createElement('div');
    this.chips.className = 'hud';
    this.hint = document.createElement('div');
    this.hint.className = 'hint hidden';
    this.keyBar = document.createElement('div');
    this.keyBar.className = 'keybar';
    root.append(this.chips, this.hint, this.keyBar);
  }

  update(state: HudState): void {
    const tracking = trackingLabel(state);
    const snapText = state.snap ? `${SNAP_NAMES[state.snap]}${state.snapAxis ? ` ${state.snapAxis.toUpperCase()}` : ''}` : '–';
    const chips: [string, string, string][] = [
      ['Mode', state.mode, `mode-${state.mode.toLowerCase()}`],
      [
        'Plane',
        `${state.plane.label} · ${state.planeMode}${state.planeReason ? ` · ${state.planeReason}` : ''}`,
        `axis-${state.plane.normalAxis}`,
      ],
      ['Snap', snapText, state.snap && state.snap !== 'free' ? `snap-${state.snap}` : 'muted'],
      ['Grid', state.gridEnabled ? formatGridStep(state.gridStep) : 'off', state.gridEnabled ? '' : 'muted'],
      ['View', state.projection, ''],
      ['Tracking', tracking.text, tracking.tone],
    ];
    if (state.depthMode) {
      if (state.scale) chips.push(['Scale', `${state.scale}×`, '']);
      if (state.trackingAgeMs !== null && state.trackingAgeMs !== undefined) {
        chips.push(['Age', `${Math.round(state.trackingAgeMs)} ms`, state.trackingAgeMs > 200 ? 'warn' : 'muted']);
      }
    }
    if (state.navAssist) chips.push(['Palm nav', 'on', 'ok']);
    const html = chips
      .map(([name, value, tone]) => `<span class="chip ${tone}"><span class="chip__name">${name}</span><span class="chip__value">${value}</span></span>`)
      .join('');
    if (html !== this.lastChips) {
      this.lastChips = html;
      this.chips.innerHTML = html;
    }
    const hintText = state.edgeOn ? `Work plane ${state.plane.label} is edge-on. Press A for auto, Tab or 1 / 2 / 3, or orbit with Shift.` : '';
    if (hintText !== this.hint.textContent) {
      this.hint.textContent = hintText;
      this.hint.classList.toggle('hidden', !hintText);
    }
  }

  setKeys(hints: readonly KeyHint[]): void {
    const html = hints.map((hint) => `<span class="key"><kbd>${hint.key}</kbd>${hint.label}</span>`).join('');
    if (html === this.lastKeys) return;
    this.lastKeys = html;
    this.keyBar.innerHTML = html;
  }
}
