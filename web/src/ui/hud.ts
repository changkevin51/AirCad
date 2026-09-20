import type { TrackingState } from '../input/cursor';
import type { CameraState, ConnectionState } from '../input/tracker-client';
import type { PlaneInfo } from '../model/plane';
import type { SnapType } from '../model/snap';
import { formatMm } from '../model/sketch';

export type Mode = 'READY' | 'DRAWING' | 'EXTRUDING' | 'MOVING' | 'SCALING' | 'ORBIT' | 'PAN';

export interface HudState {
  mode: Mode;
  plane: PlaneInfo;
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
  selected: string | null;
  extrusion: { depth: number; dragging: boolean; face: string; pulled: number } | null;
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
  if (state.camera === 'error' || state.camera === 'stopped') return { text: 'Camera error · mouse', tone: 'warn' };
  if (state.camera === 'starting') return { text: 'Camera starting', tone: 'muted' };
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
    this.hint.setAttribute('role', 'status');
    this.keyBar = document.createElement('div');
    this.keyBar.className = 'keybar';
    root.append(this.chips, this.hint, this.keyBar);
  }

  update(state: HudState): void {
    const tracking = trackingLabel(state);
    const snapText = state.snap ? `${SNAP_NAMES[state.snap]}${state.snapAxis ? ` ${state.snapAxis.toUpperCase()}` : ''}` : '–';
    const chips: [string, string, string][] = [
      ['Mode', state.mode, `mode-${state.mode.toLowerCase()}`],
      ['Plane', state.plane.label, `axis-${state.plane.normalAxis}`],
      ['Snap', snapText, state.snap && state.snap !== 'free' ? `snap-${state.snap}` : 'muted'],
      ['Grid', state.gridEnabled ? formatGridStep(state.gridStep) : 'off', state.gridEnabled ? '' : 'muted'],
      ['View', state.projection, ''],
      ['Tracking', tracking.text, tracking.tone],
    ];
    if (state.navAssist) chips.push(['Palm nav', 'on', 'ok']);
    if (state.extrusion) chips.push(['Face', state.extrusion.face, 'ok'], ['Depth', formatMm(state.extrusion.depth), 'ok']);
    else if (state.selected) chips.push(['Selected', state.selected, 'warn']);
    const html = chips
      .map(([name, value, tone]) => `<span class="chip ${tone}"><span class="chip__name">${name}</span><span class="chip__value">${value}</span></span>`)
      .join('');
    if (html !== this.lastChips) {
      this.lastChips = html;
      this.chips.innerHTML = html;
    }
    const hintText = state.extrusion
      ? state.tracking === 'lost'
        ? 'Tracking lost — depth paused. Show your hand, release the pinch, then pinch again to continue.'
        : state.mode === 'ORBIT' || state.mode === 'PAN'
          ? 'Extrusion paused while you move the view. Release Shift / Ctrl to continue pulling. Enter applies · Esc cancels.'
          : state.extrusion.dragging
            ? 'Move to pull the highlighted face out, back to push in. Release to pause. Enter applies · Esc cancels.'
            : 'Pinch thumb + index and move (or hold Space / left-drag) to pull the highlighted face. Hover another face or press Tab to switch. Enter applies · Esc cancels.'
      : state.mode === 'SCALING'
        ? state.tracking === 'lost'
          ? 'Tracking lost — scaling paused. Show your hand, release the pinch, then pinch again to continue.'
          : 'Pinch or drag a corner (or rim point) to scale proportionally. The opposite corner stays fixed. Enter / R applies · Esc cancels.'
      : state.edgeOn ? `Work plane ${state.plane.label} is edge-on. Press Tab or 1 / 2 / 3, or orbit with Shift.`
        : state.mode === 'MOVING'
          ? state.tracking === 'lost'
            ? 'Tracking lost — move paused. Show your hand, release the pinch, then pinch again to continue.'
            : 'Pinch or left-drag (or hold Space) to move on the work plane. Tab changes plane. Enter / M applies · Esc cancels.'
          : '';
    this.hint.style.top = `${this.chips.offsetTop + this.chips.offsetHeight + 10}px`;
    this.hint.classList.toggle('hint--extrusion', !!state.extrusion);
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
